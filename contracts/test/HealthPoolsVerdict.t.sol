// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HealthPools} from "../src/HealthPools.sol";
import {HealthVerdict} from "../src/HealthVerdict.sol";

/// @dev 6-decimal USDC stand-in (named distinctly from the one in
///      HealthPools.t.sol to avoid a duplicate-symbol clash at compile time).
contract MockUSDCV {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "INSUFFICIENT");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "INSUFFICIENT");
        require(allowance[from][msg.sender] >= amount, "NOT_APPROVED");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Exercises the additive Chainlink-verdict gate on HealthPools: gate OFF
///         (default, unchanged behavior) and gate ON (achiever blocked without a
///         passing verdict, paid with one).
contract HealthPoolsVerdictTest is Test {
    HealthPools internal pools;
    HealthVerdict internal verdict;
    MockUSDCV internal usdc;

    address internal oracle = makeAddr("oracle");
    address internal attester = makeAddr("attester");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant FEE = 100e6;
    uint256 internal constant FUNDING = 1000e6;
    uint256 internal constant NULL_A = uint256(keccak256("nullifier-alice"));
    uint256 internal constant NULL_B = uint256(keccak256("nullifier-bob"));

    bytes32 internal constant DIGEST = keccak256("signed-inference");

    // Mirror HealthVerdict constants at compile time so they are not evaluated
    // as external getter calls inside a vm.prank (which would consume the prank
    // before the real recordVerdict call ran). See HealthVerdict.t.sol.
    uint8 internal constant LOW = 0;
    uint8 internal constant HIGH = 2;
    uint16 internal constant FACET_AI_ATTESTED = 1 << 2;

    uint64 internal periodStart;
    uint64 internal periodEnd;

    function setUp() public {
        usdc = new MockUSDCV();
        pools = new HealthPools(address(usdc), oracle);
        verdict = new HealthVerdict(attester);

        periodStart = uint64(block.timestamp);
        periodEnd = uint64(block.timestamp + 7 days);

        address[5] memory users = [creator, alice, bob, oracle, attester];
        for (uint256 i = 0; i < users.length; i++) {
            usdc.mint(users[i], 10_000e6);
            vm.prank(users[i]);
            usdc.approve(address(pools), type(uint256).max);
        }
    }

    // ------------------------------------------------------------- helpers

    function _createAndJoinTwo(uint8 bountyModel) internal returns (uint256 poolId) {
        vm.prank(creator);
        poolId = pools.createPool(
            "sleep-streak", "7h sleep, 7 nights", FEE, periodStart, periodEnd, bountyModel, FUNDING
        );
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(bob);
        pools.joinPool(poolId, NULL_B);
    }

    function _attest(uint256 poolId, address user, bool verified, uint8 confidence) internal {
        bytes32 goalId = pools.computeGoalId(poolId, user);
        vm.prank(attester);
        verdict.recordVerdict(goalId, verified, confidence, DIGEST, FACET_AI_ATTESTED);
    }

    // --------------------------------------------------------- admin/config

    function test_setHealthVerdict_onlyOwnerAndDefaultsToZero() public {
        assertEq(pools.healthVerdict(), address(0));

        vm.prank(alice);
        vm.expectRevert(bytes("NOT_OWNER"));
        pools.setHealthVerdict(address(verdict));

        pools.setHealthVerdict(address(verdict)); // test contract is owner
        assertEq(pools.healthVerdict(), address(verdict));

        pools.setHealthVerdict(address(0)); // disable again
        assertEq(pools.healthVerdict(), address(0));
    }

    function test_computeGoalId_matchesRegistry() public view {
        bytes32 a = pools.computeGoalId(1, alice);
        bytes32 b = verdict.computeGoalId(1, alice);
        assertEq(a, b);
    }

    // --------------------------------------------------- gate OFF (default)

    /// With no registry configured, settle() behaves exactly as the original
    /// oracle-only contract: a recorded passing result is enough to get paid.
    function test_gateOff_oracleResultAlonePays() public {
        uint256 poolId = _createAndJoinTwo(1);

        vm.startPrank(oracle);
        pools.recordResult(poolId, alice, true, 10_000);
        pools.recordResult(poolId, bob, false, 0);
        vm.stopPrank();

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        // alice is the sole achiever, takes the whole pot in a pot-split pool
        uint256 pot = FUNDING + 2 * FEE;
        assertEq(usdc.balanceOf(alice), aliceBefore + pot);
        assertEq(pools.getPool(poolId).balance, 0);
    }

    // ----------------------------------------------------------- gate ON

    /// Registry configured but no verdict recorded: the oracle result is no
    /// longer sufficient, so the would-be achiever is blocked and the creator
    /// sweeps the whole pot.
    function test_gateOn_blocksAchieverWithoutVerdict() public {
        uint256 poolId = _createAndJoinTwo(1);
        pools.setHealthVerdict(address(verdict));

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 10_000); // oracle says pass...
        // ...but no verdict recorded in the registry

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        // alice is NOT counted as an achiever -> paid nothing
        assertEq(usdc.balanceOf(alice), aliceBefore);

        uint256 pot = FUNDING + 2 * FEE;
        assertEq(pools.getPool(poolId).balance, pot);

        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        pools.sweep(poolId);
        assertEq(usdc.balanceOf(creator), creatorBefore + pot);
    }

    /// Registry configured AND a passing high-confidence verdict recorded: the
    /// achiever is paid. This is the Chainlink-gated happy path.
    function test_gateOn_paysAchieverWithPassingVerdict() public {
        uint256 poolId = _createAndJoinTwo(1);
        pools.setHealthVerdict(address(verdict));

        vm.startPrank(oracle);
        pools.recordResult(poolId, alice, true, 10_000);
        pools.recordResult(poolId, bob, false, 0);
        vm.stopPrank();

        _attest(poolId, alice, true, HIGH);

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        uint256 pot = FUNDING + 2 * FEE;
        assertEq(usdc.balanceOf(alice), aliceBefore + pot);
        assertEq(pools.getPool(poolId).balance, 0);
    }

    /// A low-confidence verdict does not clear canSettle, so the achiever is
    /// still blocked even though the oracle and the verdict both say "verified".
    function test_gateOn_lowConfidenceVerdictBlocks() public {
        uint256 poolId = _createAndJoinTwo(1);
        pools.setHealthVerdict(address(verdict));

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 10_000);
        _attest(poolId, alice, true, LOW);

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(alice), aliceBefore); // blocked by low confidence
        assertEq(pools.getPool(poolId).balance, FUNDING + 2 * FEE);
    }

    /// An unverified verdict (oracle says pass, AI says fail) blocks payout: the
    /// verdict is an AND requirement on top of the oracle result.
    function test_gateOn_unverifiedVerdictBlocks() public {
        uint256 poolId = _createAndJoinTwo(1);
        pools.setHealthVerdict(address(verdict));

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 10_000);
        _attest(poolId, alice, false, HIGH);

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(alice), aliceBefore);
    }

    /// The gate also propagates to backer payouts: a backer of a verdict-blocked
    /// participant forfeits, exactly as if the participant had failed.
    function test_gateOn_backerOfBlockedParticipantForfeits() public {
        uint256 poolId = _createAndJoinTwo(1);
        pools.setHealthVerdict(address(verdict));

        // creator backs alice during the period
        usdc.mint(creator, 0);
        vm.prank(creator);
        pools.backGoal(poolId, alice, 200e6);

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 10_000);
        // no verdict -> alice is blocked

        uint256 creatorStakeBefore = usdc.balanceOf(creator);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        // backer is not refunded a stake-plus-bonus; alice counts as non-achiever
        assertEq(usdc.balanceOf(creator), creatorStakeBefore);
    }

    /// Disabling the registry mid-life restores oracle-only behavior.
    function test_gateToggleOffRestoresOracleOnly() public {
        uint256 poolId = _createAndJoinTwo(1);
        pools.setHealthVerdict(address(verdict));
        pools.setHealthVerdict(address(0)); // turn it back off

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 10_000); // no verdict needed now

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(alice), aliceBefore + FUNDING + 2 * FEE);
    }
}
