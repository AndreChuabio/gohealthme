// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HealthPools} from "../src/HealthPools.sol";

/// @dev Minimal 6-decimal USDC stand-in for tests.
contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
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

contract HealthPoolsTest is Test {
    HealthPools internal pools;
    MockUSDC internal usdc;

    address internal oracle = makeAddr("oracle");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave"); // backer
    address internal erin = makeAddr("erin"); // backer
    address internal rando = makeAddr("rando");

    uint256 internal constant FEE = 100e6;
    uint256 internal constant FUNDING = 1000e6;
    uint256 internal constant NULL_A = uint256(keccak256("nullifier-alice"));
    uint256 internal constant NULL_B = uint256(keccak256("nullifier-bob"));
    uint256 internal constant NULL_C = uint256(keccak256("nullifier-carol"));

    uint64 internal periodStart;
    uint64 internal periodEnd;

    function setUp() public {
        usdc = new MockUSDC();
        pools = new HealthPools(address(usdc), oracle);

        periodStart = uint64(block.timestamp);
        periodEnd = uint64(block.timestamp + 7 days);

        address[7] memory users = [creator, alice, bob, carol, dave, erin, rando];
        for (uint256 i = 0; i < users.length; i++) {
            usdc.mint(users[i], 10_000e6);
            vm.prank(users[i]);
            usdc.approve(address(pools), type(uint256).max);
        }
    }

    // ------------------------------------------------------------- helpers

    function _createPool(uint8 bountyModel, uint256 entryFee, uint256 funding) internal returns (uint256 poolId) {
        vm.prank(creator);
        poolId = pools.createPool("sleep-streak", "7h sleep, 7 nights", entryFee, periodStart, periodEnd, bountyModel, funding);
    }

    function _joinThree(uint256 poolId) internal {
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(bob);
        pools.joinPool(poolId, NULL_B);
        vm.prank(carol);
        pools.joinPool(poolId, NULL_C);
    }

    // ---------------------------------------------------------- create/join

    function test_createPool_storesAndPullsFunding() public {
        uint256 creatorBefore = usdc.balanceOf(creator);
        uint256 poolId = _createPool(1, FEE, FUNDING);

        assertEq(poolId, 1);
        assertEq(pools.poolCount(), 1);
        assertEq(usdc.balanceOf(creator), creatorBefore - FUNDING);
        assertEq(usdc.balanceOf(address(pools)), FUNDING);

        HealthPools.Pool memory p = pools.getPool(poolId);
        assertEq(p.creator, creator);
        assertEq(p.entryFee, FEE);
        assertEq(p.balance, FUNDING);
        assertEq(p.bountyModel, 1);
        assertEq(p.periodStart, periodStart);
        assertEq(p.periodEnd, periodEnd);
        assertEq(p.initiative, "sleep-streak");
        assertEq(p.goalSpec, "7h sleep, 7 nights");
        assertFalse(p.settled);
    }

    function test_createPool_revertsOnBadParams() public {
        vm.startPrank(creator);
        vm.expectRevert(bytes("BAD_PERIOD"));
        pools.createPool("x", "y", FEE, periodEnd, periodStart, 0, 0);
        vm.expectRevert(bytes("BAD_BOUNTY_MODEL"));
        pools.createPool("x", "y", FEE, periodStart, periodEnd, 2, 0);
        vm.expectRevert(bytes("PERIOD_IN_PAST"));
        pools.createPool("x", "y", FEE, 0, uint64(block.timestamp), 0, 0);
        vm.stopPrank();
    }

    function test_joinPool_pullsFeeAndStoresParticipant() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        _joinThree(poolId);

        assertEq(pools.participantCount(poolId), 3);
        assertEq(usdc.balanceOf(address(pools)), FUNDING + 3 * FEE);
        assertEq(pools.getPool(poolId).balance, FUNDING + 3 * FEE);

        HealthPools.Participant memory part = pools.getParticipant(poolId, alice);
        assertTrue(part.joined);
        assertEq(part.nullifierHash, NULL_A);
        assertFalse(part.resultRecorded);
        assertTrue(pools.nullifierUsed(poolId, NULL_A));
    }

    function test_joinPool_nullifierReuseReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);

        // same human, different wallet, same World ID nullifier
        vm.prank(bob);
        vm.expectRevert(bytes("NULLIFIER_USED"));
        pools.joinPool(poolId, NULL_A);
    }

    function test_joinPool_doubleJoinReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);

        vm.prank(alice);
        vm.expectRevert(bytes("ALREADY_JOINED"));
        pools.joinPool(poolId, NULL_B);
    }

    function test_joinPool_afterPeriodEndReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.warp(periodEnd);
        vm.prank(alice);
        vm.expectRevert(bytes("PERIOD_ENDED"));
        pools.joinPool(poolId, NULL_A);
    }

    // --------------------------------------------------------- recordResult

    function test_recordResult_onlyOracle() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);

        vm.prank(rando);
        vm.expectRevert(bytes("NOT_ORACLE"));
        pools.recordResult(poolId, alice, true, 10_000);

        // even the owner cannot record
        vm.expectRevert(bytes("NOT_ORACLE"));
        pools.recordResult(poolId, alice, true, 10_000);
    }

    function test_recordResult_multiplierCapEnforced() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);

        vm.prank(oracle);
        vm.expectRevert(bytes("MULTIPLIER_TOO_HIGH"));
        pools.recordResult(poolId, alice, true, 30_001);

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 30_000); // exactly 3x is fine
        assertEq(pools.getParticipant(poolId, alice).multiplierBps, 30_000);
    }

    function test_recordResult_oneShotAndParticipantOnly() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);

        vm.prank(oracle);
        vm.expectRevert(bytes("NOT_PARTICIPANT"));
        pools.recordResult(poolId, rando, true, 10_000);

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 10_000);
        vm.prank(oracle);
        vm.expectRevert(bytes("ALREADY_RECORDED"));
        pools.recordResult(poolId, alice, false, 10_000);
    }

    // --------------------------------------------------------------- settle

    /// Full happy path, bountyModel 1 (pot split pro-rata by multiplier).
    function test_settle_potSplit_happyPath() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        _joinThree(poolId);

        vm.startPrank(oracle);
        pools.recordResult(poolId, alice, true, 10_000); // 1x
        pools.recordResult(poolId, bob, true, 20_000); // 2x
        pools.recordResult(poolId, carol, false, 0);
        vm.stopPrank();

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 carolBefore = usdc.balanceOf(carol);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        // pot = 1000 funding + 3 * 100 fees = 1300e6, split 1:2
        uint256 pot = FUNDING + 3 * FEE;
        uint256 alicePay = (pot * 10_000) / 30_000; // 433_333_333
        uint256 bobPay = (pot * 20_000) / 30_000; // 866_666_666
        assertEq(usdc.balanceOf(alice), aliceBefore + alicePay);
        assertEq(usdc.balanceOf(bob), bobBefore + bobPay);
        assertEq(usdc.balanceOf(carol), carolBefore); // failed: fee forfeited

        // only rounding dust remains
        HealthPools.Pool memory p = pools.getPool(poolId);
        assertTrue(p.settled);
        assertEq(p.balance, pot - alicePay - bobPay);
        assertEq(p.balance, 1); // dust

        // creator sweeps the dust
        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        pools.sweep(poolId);
        assertEq(usdc.balanceOf(creator), creatorBefore + 1);
        assertEq(pools.getPool(poolId).balance, 0);
    }

    /// Full happy path, bountyModel 0 (fixed bounty = entryFee * multiplier).
    function test_settle_fixedBounty_happyPath() public {
        uint256 poolId = _createPool(0, FEE, FUNDING);
        _joinThree(poolId);

        vm.startPrank(oracle);
        pools.recordResult(poolId, alice, true, 10_000); // owed 100e6
        pools.recordResult(poolId, bob, true, 30_000); // owed 300e6
        pools.recordResult(poolId, carol, false, 0);
        vm.stopPrank();

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(alice), aliceBefore + 100e6);
        assertEq(usdc.balanceOf(bob), bobBefore + 300e6);

        // 1300e6 in, 400e6 paid out -> creator sweeps 900e6
        assertEq(pools.getPool(poolId).balance, 900e6);
        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        pools.sweep(poolId);
        assertEq(usdc.balanceOf(creator), creatorBefore + 900e6);
    }

    /// bountyModel 0 with an underfunded pool scales payouts pro-rata instead
    /// of reverting (the demo must not revert on stage).
    function test_settle_fixedBounty_underfundedScalesProRata() public {
        uint256 poolId = _createPool(0, FEE, 0); // no initial funding
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 30_000); // owed 300e6, pot only 100e6

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(alice), aliceBefore + 100e6); // whole pot, no revert
        assertEq(pools.getPool(poolId).balance, 0);
    }

    function test_settle_beforePeriodEndReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        _joinThree(poolId);

        vm.expectRevert(bytes("PERIOD_NOT_ENDED"));
        pools.settle(poolId);

        vm.warp(periodEnd); // still not strictly after
        vm.expectRevert(bytes("PERIOD_NOT_ENDED"));
        pools.settle(poolId);
    }

    function test_settle_twiceReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);
        vm.expectRevert(bytes("ALREADY_SETTLED"));
        pools.settle(poolId);
    }

    function test_settle_noAchievers_creatorSweepsEverything() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        _joinThree(poolId);
        vm.prank(oracle);
        pools.recordResult(poolId, alice, false, 0);
        // bob and carol never get a result recorded -> treated as failed

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        pools.sweep(poolId);
        assertEq(usdc.balanceOf(creator), creatorBefore + FUNDING + 3 * FEE);
    }

    // -------------------------------------------------------------- backing

    function test_backGoal_payoutMath() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(bob);
        pools.joinPool(poolId, NULL_B);

        // dave backs alice (achiever-to-be), erin backs bob (failure-to-be)
        vm.prank(dave);
        pools.backGoal(poolId, alice, 500e6);
        vm.prank(erin);
        pools.backGoal(poolId, bob, 200e6);

        // pool balance = 1000 funding + 200 fees + 700 backing = 1900e6
        assertEq(pools.getPool(poolId).balance, 1900e6);
        assertEq(pools.getParticipant(poolId, alice).backingTotal, 500e6);
        assertEq(pools.backerStake(poolId, alice, dave), 500e6);

        vm.startPrank(oracle);
        pools.recordResult(poolId, alice, true, 15_000);
        pools.recordResult(poolId, bob, false, 0);
        vm.stopPrank();

        uint256 daveBefore = usdc.balanceOf(dave);
        uint256 erinBefore = usdc.balanceOf(erin);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        // dave: 500 stake back + 20% bonus (100) = 600e6
        assertEq(usdc.balanceOf(dave), daveBefore + 600e6);
        // erin forfeits her 200e6 stake into the pool
        assertEq(usdc.balanceOf(erin), erinBefore);
        // alice is sole achiever in a pot-split pool: 1900 - 600 = 1300e6
        assertEq(usdc.balanceOf(alice), aliceBefore + 1300e6);
        assertEq(pools.getPool(poolId).balance, 0);
    }

    function test_backGoal_bonusCappedByPoolHeadroom() public {
        // No funding, no fees: pool holds only the backing stake itself, so
        // there is zero headroom for the 20% bonus.
        uint256 poolId = _createPool(1, 0, 0);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(dave);
        pools.backGoal(poolId, alice, 500e6);

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 10_000);

        uint256 daveBefore = usdc.balanceOf(dave);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(dave), daveBefore + 500e6); // stake back, no bonus
        assertEq(pools.getPool(poolId).balance, 0);
    }

    function test_backGoal_afterResultRecordedReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 10_000);

        // no risk-free backing of a known achiever
        vm.prank(dave);
        vm.expectRevert(bytes("RESULT_KNOWN"));
        pools.backGoal(poolId, alice, 100e6);
    }

    function test_backGoal_nonParticipantReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(dave);
        vm.expectRevert(bytes("NOT_PARTICIPANT"));
        pools.backGoal(poolId, rando, 100e6);
    }

    // ------------------------------------------------------- fundPool/sweep

    function test_fundPool_topsUpBalance() public {
        uint256 poolId = _createPool(1, FEE, 0);
        vm.prank(rando);
        pools.fundPool(poolId, 250e6);
        assertEq(pools.getPool(poolId).balance, 250e6);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);
        vm.prank(rando);
        vm.expectRevert(bytes("SETTLED"));
        pools.fundPool(poolId, 1e6);
    }

    function test_sweep_accessControl() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);

        vm.prank(creator);
        vm.expectRevert(bytes("NOT_SETTLED"));
        pools.sweep(poolId);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        vm.prank(rando);
        vm.expectRevert(bytes("NOT_CREATOR"));
        pools.sweep(poolId);

        vm.prank(creator);
        pools.sweep(poolId);
        assertEq(pools.getPool(poolId).balance, 0);
    }

    // ---------------------------------------------------------------- admin

    function test_setOracle_onlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(bytes("NOT_OWNER"));
        pools.setOracle(rando);

        pools.setOracle(rando); // test contract is owner
        assertEq(pools.oracle(), rando);
    }

    // ---------------------------------------------------------------- views

    function test_getBackers() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(dave);
        pools.backGoal(poolId, alice, 100e6);
        vm.prank(dave);
        pools.backGoal(poolId, alice, 50e6); // accumulates, no duplicate entry
        vm.prank(erin);
        pools.backGoal(poolId, alice, 25e6);

        (address[] memory backers, uint256[] memory stakes) = pools.getBackers(poolId, alice);
        assertEq(backers.length, 2);
        assertEq(backers[0], dave);
        assertEq(stakes[0], 150e6);
        assertEq(backers[1], erin);
        assertEq(stakes[1], 25e6);
    }

    function test_getPool_unknownIdReverts() public {
        vm.expectRevert(bytes("NO_POOL"));
        pools.getPool(42);
    }
}
