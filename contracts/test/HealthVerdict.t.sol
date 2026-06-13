// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HealthVerdict} from "../src/HealthVerdict.sol";

contract HealthVerdictTest is Test {
    HealthVerdict internal reg;

    address internal owner = address(this); // deployer is owner
    address internal attester = makeAddr("attester");
    address internal rando = makeAddr("rando");

    bytes32 internal goalId = keccak256("goal-1");
    bytes32 internal digest = keccak256("signed-inference");

    // Mirror constants evaluated at compile time. Calling the contract's public
    // constant getters inside a vm.prank() would consume the prank on the getter
    // call (it is an external call), so recordVerdict would then run from the
    // wrong sender. Using these local copies keeps the prank on recordVerdict.
    uint8 internal constant LOW = 0;
    uint8 internal constant MEDIUM = 1;
    uint8 internal constant HIGH = 2;
    uint16 internal constant FACET_WEARABLE = 1 << 0;
    uint16 internal constant FACET_WORLD_ID = 1 << 1;
    uint16 internal constant FACET_AI_ATTESTED = 1 << 2;
    uint16 internal constant FACET_NOT_DUPLICATE = 1 << 3;
    uint16 internal constant ALL_FACETS =
        FACET_WEARABLE | FACET_WORLD_ID | FACET_AI_ATTESTED | FACET_NOT_DUPLICATE;

    function setUp() public {
        reg = new HealthVerdict(attester);
    }

    // -------------------------------------------------------- constructor

    function test_constructor_setsOwnerAndAttester() public view {
        assertEq(reg.owner(), owner);
        assertEq(reg.attester(), attester);
    }

    function test_constructor_zeroAttesterReverts() public {
        vm.expectRevert(bytes("ZERO_ATTESTER"));
        new HealthVerdict(address(0));
    }

    // ------------------------------------------------------------- record

    function test_recordVerdict_happyPath_highConfidence() public {
        uint16 bitmap = ALL_FACETS;
        vm.prank(attester);
        reg.recordVerdict(goalId, true, HIGH, digest, bitmap);

        HealthVerdict.Verdict memory v = reg.getVerdict(goalId);
        assertTrue(v.verified);
        assertEq(v.confidence, HIGH);
        assertEq(v.digest, digest);
        assertEq(v.attester, attester);
        assertEq(v.bitmap, bitmap);
        assertEq(v.timestamp, uint64(block.timestamp));
        assertTrue(reg.recorded(goalId));
        assertTrue(reg.canSettle(goalId));
    }

    function test_recordVerdict_onlyAttester() public {
        vm.prank(rando);
        vm.expectRevert(bytes("NOT_ATTESTER"));
        reg.recordVerdict(goalId, true, HIGH, digest, 0);

        // even the owner cannot record (only the attester role can)
        vm.expectRevert(bytes("NOT_ATTESTER"));
        reg.recordVerdict(goalId, true, HIGH, digest, 0);
    }

    function test_recordVerdict_oneShotReverts() public {
        vm.startPrank(attester);
        reg.recordVerdict(goalId, true, HIGH, digest, 0);
        vm.expectRevert(bytes("ALREADY_RECORDED"));
        reg.recordVerdict(goalId, false, LOW, digest, 0);
        vm.stopPrank();
    }

    function test_recordVerdict_badConfidenceReverts() public {
        vm.prank(attester);
        vm.expectRevert(bytes("BAD_CONFIDENCE"));
        reg.recordVerdict(goalId, true, 3, digest, 0); // valid tiers are 0..2
    }

    function test_recordVerdict_badBitmapReverts() public {
        uint16 unknownBit = 1 << 4; // outside FACET_MASK
        vm.prank(attester);
        vm.expectRevert(bytes("BAD_BITMAP"));
        reg.recordVerdict(goalId, true, HIGH, digest, unknownBit);
    }

    // -------------------------------------------------- confidence tiers

    function test_canSettle_confidenceTiers() public {
        bytes32 low = keccak256("low");
        bytes32 med = keccak256("med");
        bytes32 high = keccak256("high");

        vm.startPrank(attester);
        reg.recordVerdict(low, true, LOW, digest, 0);
        reg.recordVerdict(med, true, MEDIUM, digest, 0);
        reg.recordVerdict(high, true, HIGH, digest, 0);
        vm.stopPrank();

        assertFalse(reg.canSettle(low)); // low confidence blocks
        assertTrue(reg.canSettle(med));
        assertTrue(reg.canSettle(high));
    }

    function test_canSettle_unverifiedBlocksEvenAtHighConfidence() public {
        vm.prank(attester);
        reg.recordVerdict(goalId, false, HIGH, digest, 0);
        assertFalse(reg.canSettle(goalId));
    }

    function test_canSettle_unknownGoalIsFalse() public view {
        assertFalse(reg.canSettle(keccak256("never-recorded")));
    }

    // ------------------------------------------------------------ bitmap

    function test_hasFacet_individualBits() public {
        uint16 bitmap = FACET_WEARABLE | FACET_AI_ATTESTED;
        vm.prank(attester);
        reg.recordVerdict(goalId, true, HIGH, digest, bitmap);

        assertTrue(reg.hasFacet(goalId, FACET_WEARABLE));
        assertTrue(reg.hasFacet(goalId, FACET_AI_ATTESTED));
        assertFalse(reg.hasFacet(goalId, FACET_WORLD_ID));
        assertFalse(reg.hasFacet(goalId, FACET_NOT_DUPLICATE));
    }

    function test_facetMask_coversAllNamedBits() public view {
        assertEq(reg.FACET_MASK(), ALL_FACETS);
    }

    // ------------------------------------------------------- admin/override

    function test_setAttester_onlyOwnerAndUpdates() public {
        vm.prank(rando);
        vm.expectRevert(bytes("NOT_OWNER"));
        reg.setAttester(rando);

        reg.setAttester(rando); // owner is the test contract
        assertEq(reg.attester(), rando);

        vm.prank(rando);
        reg.recordVerdict(goalId, true, HIGH, digest, 0);
        assertTrue(reg.canSettle(goalId));
    }

    function test_setAttester_zeroReverts() public {
        vm.expectRevert(bytes("ZERO_ATTESTER"));
        reg.setAttester(address(0));
    }

    function test_overrideVerdict_ownerCorrectsBadAttestation() public {
        vm.prank(attester);
        reg.recordVerdict(goalId, true, HIGH, digest, 0);
        assertTrue(reg.canSettle(goalId));

        // owner flips a bad attestation
        bytes32 newDigest = keccak256("corrected");
        reg.overrideVerdict(goalId, false, LOW, newDigest, 0);
        assertFalse(reg.canSettle(goalId));
        assertEq(reg.getVerdict(goalId).digest, newDigest);
        assertEq(reg.getVerdict(goalId).attester, owner);
    }

    function test_overrideVerdict_onlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(bytes("NOT_OWNER"));
        reg.overrideVerdict(goalId, true, HIGH, digest, 0);
    }

    function test_transferOwnership() public {
        reg.transferOwnership(rando);
        assertEq(reg.owner(), rando);
        vm.expectRevert(bytes("NOT_OWNER"));
        reg.setAttester(rando); // old owner can no longer admin
    }

    // ------------------------------------------------------------ helpers

    function test_computeGoalId_matchesKeccak() public {
        uint256 poolId = 7;
        address participant = makeAddr("participant");
        assertEq(reg.computeGoalId(poolId, participant), keccak256(abi.encode(poolId, participant)));
    }
}
