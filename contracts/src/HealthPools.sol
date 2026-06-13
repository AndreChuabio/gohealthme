// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal ERC-20 surface needed for pool accounting. On Arc testnet the
///      canonical USDC ERC-20 interface lives at
///      0x3600000000000000000000000000000000000000 (6 decimals).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Minimal surface of the optional verdict registry. When configured,
///      HealthPools requires canSettle(goalId) to be true before a participant
///      counts as an achiever. See HealthVerdict.sol.
interface IHealthVerdict {
    function canSettle(bytes32 goalId) external view returns (bool);
}

/// @title HealthPools
/// @notice Sybil-resistant health-goal bounty pools settled in USDC (GoHealthMe,
///         ETHGlobal NY 2026). Privacy invariant: raw health data never touches
///         the chain — only oracle verdicts and multipliers do. World ID sybil
///         resistance is enforced via one nullifierHash per pool.
///
/// Bounty models:
///   0 = fixed bounty per achiever: each achiever is owed
///       entryFee * multiplierBps / 10000 (scaled down pro-rata if the pool
///       cannot cover everyone). Unspent funds are sweepable by the creator
///       after settlement.
///   1 = pot split: achievers split the entire remaining pot pro-rata by
///       multiplierBps. Only rounding dust is left to sweep.
///
/// Backing: anyone can stake USDC behind a participant before that
/// participant's result is recorded. Backers of achievers get their stake back
/// plus a 20% bonus paid from the pool (capped by pool headroom). Backers of
/// failures (or of participants with no recorded result) forfeit their stake
/// into the pool.
contract HealthPools {
    // ---------------------------------------------------------------- types

    struct Pool {
        address creator;
        uint8 bountyModel; // 0 = fixed bounty per achiever, 1 = pro-rata pot split
        bool settled;
        uint64 periodStart;
        uint64 periodEnd;
        uint256 entryFee; // USDC (6 decimals)
        uint256 balance; // USDC currently attributable to this pool
        string initiative;
        string goalSpec;
    }

    struct Participant {
        bool joined;
        bool resultRecorded;
        bool verdict;
        uint16 multiplierBps; // 10000 = 1x, hard-capped at 30000 (3x)
        uint256 nullifierHash; // World ID nullifier used to join
        uint256 backingTotal; // total USDC staked behind this participant
    }

    // ------------------------------------------------------------ constants

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_MULTIPLIER_BPS = 30_000; // 3x trailing-baseline cap
    uint256 public constant BACKER_BONUS_BPS = 2_000; // 20% bonus for backers of achievers
    uint256 public constant MAX_PARTICIPANTS = 200; // keeps settle() gas-bounded
    uint256 public constant MAX_BACKERS_PER_GOAL = 50; // keeps settle() gas-bounded

    // -------------------------------------------------------------- storage

    IERC20 public immutable usdc;
    address public owner;
    address public oracle;

    /// @notice Optional Chainlink Confidential AI verdict registry. When set to a
    ///         non-zero address, settle() additionally requires a passing verdict
    ///         (canSettle) for each participant to count as an achiever. Default
    ///         address(0) preserves the original oracle-only behavior exactly.
    address public healthVerdict;

    uint256 public poolCount; // pool ids run 1..poolCount
    mapping(uint256 => Pool) internal pools;
    mapping(uint256 => address[]) internal participantList;
    mapping(uint256 => mapping(address => Participant)) internal participants;
    mapping(uint256 => mapping(uint256 => bool)) public nullifierUsed;
    mapping(uint256 => mapping(address => address[])) internal backerList;
    mapping(uint256 => mapping(address => mapping(address => uint256))) public backerStake;

    uint256 private _lock = 1;

    // --------------------------------------------------------------- events

    event PoolCreated(
        uint256 indexed poolId,
        address indexed creator,
        string initiative,
        string goalSpec,
        uint256 entryFee,
        uint64 periodStart,
        uint64 periodEnd,
        uint8 bountyModel
    );
    event PoolJoined(uint256 indexed poolId, address indexed participant, uint256 nullifierHash);
    event ResultRecorded(uint256 indexed poolId, address indexed participant, bool verdict, uint16 multiplierBps);
    event GoalBacked(uint256 indexed poolId, address indexed participant, address indexed backer, uint256 amount);
    event PoolFunded(uint256 indexed poolId, address indexed funder, uint256 amount);
    event BackerPaid(uint256 indexed poolId, address indexed backer, address participant, uint256 amount);
    event AchieverPaid(uint256 indexed poolId, address indexed participant, uint256 amount);
    event PoolSettled(uint256 indexed poolId, uint256 achieverCount, uint256 totalPaid);
    event FundsSwept(uint256 indexed poolId, address indexed creator, uint256 amount);
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event HealthVerdictUpdated(address indexed previousRegistry, address indexed newRegistry);

    // ------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == oracle, "NOT_ORACLE");
        _;
    }

    modifier nonReentrant() {
        require(_lock == 1, "REENTRANCY");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ----------------------------------------------------------- constructor

    /// @param token  ERC-20 used for all pool accounting (Arc testnet USDC in prod,
    ///               a mock in tests).
    /// @param oracle_ signer allowed to call recordResult.
    constructor(address token, address oracle_) {
        require(token != address(0), "ZERO_TOKEN");
        require(oracle_ != address(0), "ZERO_ORACLE");
        usdc = IERC20(token);
        owner = msg.sender;
        oracle = oracle_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OracleUpdated(address(0), oracle_);
    }

    // ----------------------------------------------------------- pool admin

    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "ZERO_ORACLE");
        emit OracleUpdated(oracle, newOracle);
        oracle = newOracle;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Enable, swap, or disable the verdict-gating registry. Pass
    ///         address(0) to disable and fall back to the oracle-only path.
    function setHealthVerdict(address newRegistry) external onlyOwner {
        emit HealthVerdictUpdated(healthVerdict, newRegistry);
        healthVerdict = newRegistry;
    }

    // -------------------------------------------------------------- actions

    /// @notice Permissionless pool creation. Pulls initialFunding USDC from the
    ///         caller (requires prior approval).
    function createPool(
        string calldata initiative,
        string calldata goalSpec,
        uint256 entryFee,
        uint64 periodStart,
        uint64 periodEnd,
        uint8 bountyModel,
        uint256 initialFunding
    ) external nonReentrant returns (uint256 poolId) {
        require(periodEnd > periodStart, "BAD_PERIOD");
        require(periodEnd > block.timestamp, "PERIOD_IN_PAST");
        require(bountyModel <= 1, "BAD_BOUNTY_MODEL");

        poolId = ++poolCount;
        Pool storage p = pools[poolId];
        p.creator = msg.sender;
        p.bountyModel = bountyModel;
        p.periodStart = periodStart;
        p.periodEnd = periodEnd;
        p.entryFee = entryFee;
        p.initiative = initiative;
        p.goalSpec = goalSpec;

        if (initialFunding > 0) {
            _pull(msg.sender, initialFunding);
            p.balance = initialFunding;
        }

        emit PoolCreated(poolId, msg.sender, initiative, goalSpec, entryFee, periodStart, periodEnd, bountyModel);
    }

    /// @notice Join a pool with a World ID nullifier. One nullifier per pool =
    ///         one human per pool. Pulls entryFee USDC from the caller.
    function joinPool(uint256 poolId, uint256 nullifierHash) external nonReentrant {
        Pool storage p = _existingPool(poolId);
        require(!p.settled, "SETTLED");
        require(block.timestamp < p.periodEnd, "PERIOD_ENDED");
        require(!nullifierUsed[poolId][nullifierHash], "NULLIFIER_USED");
        require(!participants[poolId][msg.sender].joined, "ALREADY_JOINED");
        require(participantList[poolId].length < MAX_PARTICIPANTS, "POOL_FULL");

        nullifierUsed[poolId][nullifierHash] = true;
        Participant storage part = participants[poolId][msg.sender];
        part.joined = true;
        part.nullifierHash = nullifierHash;
        participantList[poolId].push(msg.sender);

        if (p.entryFee > 0) {
            _pull(msg.sender, p.entryFee);
            p.balance += p.entryFee;
        }

        emit PoolJoined(poolId, msg.sender, nullifierHash);
    }

    /// @notice Oracle posts the verdict for a participant. One shot per
    ///         participant per pool. multiplierBps capped at 3x.
    function recordResult(uint256 poolId, address user, bool verdict, uint16 multiplierBps) external onlyOracle {
        Pool storage p = _existingPool(poolId);
        require(!p.settled, "SETTLED");
        require(multiplierBps <= MAX_MULTIPLIER_BPS, "MULTIPLIER_TOO_HIGH");

        Participant storage part = participants[poolId][user];
        require(part.joined, "NOT_PARTICIPANT");
        require(!part.resultRecorded, "ALREADY_RECORDED");

        part.resultRecorded = true;
        part.verdict = verdict;
        part.multiplierBps = multiplierBps;

        emit ResultRecorded(poolId, user, verdict, multiplierBps);
    }

    /// @notice Stake USDC behind a participant. Must happen during the period
    ///         and before that participant's result is recorded (no risk-free
    ///         backing of known achievers).
    function backGoal(uint256 poolId, address user, uint256 amount) external nonReentrant {
        Pool storage p = _existingPool(poolId);
        require(!p.settled, "SETTLED");
        require(block.timestamp < p.periodEnd, "PERIOD_ENDED");
        require(amount > 0, "ZERO_AMOUNT");

        Participant storage part = participants[poolId][user];
        require(part.joined, "NOT_PARTICIPANT");
        require(!part.resultRecorded, "RESULT_KNOWN");

        if (backerStake[poolId][user][msg.sender] == 0) {
            require(backerList[poolId][user].length < MAX_BACKERS_PER_GOAL, "TOO_MANY_BACKERS");
            backerList[poolId][user].push(msg.sender);
        }
        backerStake[poolId][user][msg.sender] += amount;
        part.backingTotal += amount;

        _pull(msg.sender, amount);
        p.balance += amount;

        emit GoalBacked(poolId, user, msg.sender, amount);
    }

    /// @notice Top up any unsettled pool with USDC.
    function fundPool(uint256 poolId, uint256 amount) external nonReentrant {
        Pool storage p = _existingPool(poolId);
        require(!p.settled, "SETTLED");
        require(amount > 0, "ZERO_AMOUNT");

        _pull(msg.sender, amount);
        p.balance += amount;

        emit PoolFunded(poolId, msg.sender, amount);
    }

    /// @notice Settle a pool after its period ends. Pays backers of achievers
    ///         (stake + up to 20% bonus), then pays achievers per the bounty
    ///         model. Failed participants' entry fees and forfeited backing
    ///         stay in the pool for the creator to sweep.
    function settle(uint256 poolId) external nonReentrant {
        Pool storage p = _existingPool(poolId);
        require(block.timestamp > p.periodEnd, "PERIOD_NOT_ENDED");
        require(!p.settled, "ALREADY_SETTLED");
        p.settled = true;

        (uint256 achieverCount, uint256 sumMultiplierBps, uint256 backingOnAchievers) = _tally(poolId);

        uint256 paidToBackers = _payBackers(poolId, p, backingOnAchievers);
        uint256 paidToAchievers = _payAchievers(poolId, p, sumMultiplierBps);

        emit PoolSettled(poolId, achieverCount, paidToBackers + paidToAchievers);
    }

    /// @notice Creator reclaims whatever is left in the pool after settlement
    ///         (forfeited fees/backing, unspent funding, rounding dust).
    function sweep(uint256 poolId) external nonReentrant {
        Pool storage p = _existingPool(poolId);
        require(p.settled, "NOT_SETTLED");
        require(msg.sender == p.creator, "NOT_CREATOR");

        uint256 amount = p.balance;
        require(amount > 0, "NOTHING_TO_SWEEP");
        p.balance = 0;
        _push(msg.sender, amount);

        emit FundsSwept(poolId, msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    function getPool(uint256 poolId) external view returns (Pool memory) {
        _existingPool(poolId);
        return pools[poolId];
    }

    function getParticipant(uint256 poolId, address user) external view returns (Participant memory) {
        return participants[poolId][user];
    }

    function getParticipants(uint256 poolId) external view returns (address[] memory) {
        return participantList[poolId];
    }

    function participantCount(uint256 poolId) external view returns (uint256) {
        return participantList[poolId].length;
    }

    /// @notice Backers of a participant's goal with their current stakes.
    function getBackers(uint256 poolId, address user)
        external
        view
        returns (address[] memory backers, uint256[] memory stakes)
    {
        backers = backerList[poolId][user];
        stakes = new uint256[](backers.length);
        for (uint256 i = 0; i < backers.length; i++) {
            stakes[i] = backerStake[poolId][user][backers[i]];
        }
    }

    // ------------------------------------------------------------ internals

    function _existingPool(uint256 poolId) internal view returns (Pool storage p) {
        require(poolId >= 1 && poolId <= poolCount, "NO_POOL");
        p = pools[poolId];
    }

    /// @dev A participant is an achiever iff the oracle recorded a passing
    ///      result AND, when the verdict registry is configured, that registry
    ///      also clears them via canSettle. With healthVerdict == address(0) this
    ///      is identical to the original `resultRecorded && verdict` check, so the
    ///      proven happy path is unchanged.
    function _isAchiever(uint256 poolId, address user) internal view returns (bool) {
        Participant storage part = participants[poolId][user];
        if (!(part.resultRecorded && part.verdict)) return false;

        address registry = healthVerdict;
        if (registry == address(0)) return true;

        return IHealthVerdict(registry).canSettle(computeGoalId(poolId, user));
    }

    /// @notice Deterministic goal id shared with the off-chain CRE pipeline and
    ///         the HealthVerdict registry. All three must agree on this hash.
    function computeGoalId(uint256 poolId, address participant) public pure returns (bytes32) {
        return keccak256(abi.encode(poolId, participant));
    }

    /// @dev Aggregate achiever stats for settlement. Bounded by MAX_PARTICIPANTS.
    function _tally(uint256 poolId)
        internal
        view
        returns (uint256 achieverCount, uint256 sumMultiplierBps, uint256 backingOnAchievers)
    {
        address[] storage plist = participantList[poolId];
        for (uint256 i = 0; i < plist.length; i++) {
            address user = plist[i];
            if (_isAchiever(poolId, user)) {
                Participant storage part = participants[poolId][user];
                achieverCount++;
                sumMultiplierBps += part.multiplierBps;
                backingOnAchievers += part.backingTotal;
            }
        }
    }

    /// @dev Pays every backer of every achiever: stake back plus a pro-rata cut
    ///      of a bonus pot equal to 20% of total achiever backing, capped by
    ///      what the pool can afford beyond the stakes themselves.
    function _payBackers(uint256 poolId, Pool storage p, uint256 backingOnAchievers)
        internal
        returns (uint256 totalPaid)
    {
        if (backingOnAchievers == 0) return 0;

        uint256 bonusPot = (backingOnAchievers * BACKER_BONUS_BPS) / BPS;
        uint256 headroom = p.balance - backingOnAchievers; // stakes are part of balance
        if (bonusPot > headroom) bonusPot = headroom;

        address[] storage plist = participantList[poolId];
        for (uint256 i = 0; i < plist.length; i++) {
            if (!_isAchiever(poolId, plist[i])) continue;
            totalPaid += _payBackersOf(poolId, p, plist[i], bonusPot, backingOnAchievers);
        }
    }

    /// @dev Pays all backers of a single achiever.
    function _payBackersOf(uint256 poolId, Pool storage p, address user, uint256 bonusPot, uint256 backingOnAchievers)
        internal
        returns (uint256 totalPaid)
    {
        address[] storage blist = backerList[poolId][user];
        for (uint256 j = 0; j < blist.length; j++) {
            address backer = blist[j];
            uint256 stake = backerStake[poolId][user][backer];
            if (stake == 0) continue;
            uint256 payout = stake + (stake * bonusPot) / backingOnAchievers;
            backerStake[poolId][user][backer] = 0;
            p.balance -= payout;
            _push(backer, payout);
            totalPaid += payout;
            emit BackerPaid(poolId, backer, user, payout);
        }
    }

    /// @dev Pays achievers according to the pool's bounty model from whatever
    ///      remains in the pool after backer payouts.
    function _payAchievers(uint256 poolId, Pool storage p, uint256 sumMultiplierBps)
        internal
        returns (uint256 totalPaid)
    {
        if (sumMultiplierBps == 0) return 0;
        uint256 pot = p.balance;
        if (pot == 0) return 0;

        address[] storage plist = participantList[poolId];

        if (p.bountyModel == 0) {
            // Fixed bounty per achiever, scaled down pro-rata if underfunded.
            uint256 totalOwed;
            for (uint256 i = 0; i < plist.length; i++) {
                if (_isAchiever(poolId, plist[i])) {
                    totalOwed += (p.entryFee * participants[poolId][plist[i]].multiplierBps) / BPS;
                }
            }
            if (totalOwed == 0) return 0;
            for (uint256 i = 0; i < plist.length; i++) {
                address user = plist[i];
                if (!_isAchiever(poolId, user)) continue;
                uint256 owed = (p.entryFee * participants[poolId][user].multiplierBps) / BPS;
                uint256 payout = totalOwed > pot ? (owed * pot) / totalOwed : owed;
                if (payout == 0) continue;
                p.balance -= payout;
                _push(user, payout);
                totalPaid += payout;
                emit AchieverPaid(poolId, user, payout);
            }
        } else {
            // Achievers split the whole pot pro-rata by multiplier.
            for (uint256 i = 0; i < plist.length; i++) {
                address user = plist[i];
                if (!_isAchiever(poolId, user)) continue;
                uint256 payout = (pot * participants[poolId][user].multiplierBps) / sumMultiplierBps;
                if (payout == 0) continue;
                p.balance -= payout;
                _push(user, payout);
                totalPaid += payout;
                emit AchieverPaid(poolId, user, payout);
            }
        }
    }

    // SafeERC20-style transfer helpers: tolerate tokens returning nothing,
    // revert on `false` or call failure.

    function _pull(address from, uint256 amount) internal {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FROM_FAILED");
    }

    function _push(address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FAILED");
    }
}
