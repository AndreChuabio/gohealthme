// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {HealthPools} from "../src/HealthPools.sol";

/// @notice Deploys HealthPools to Arc testnet (chain id 5042002).
///
/// Required env vars:
///   DEPLOYER_PRIVATE_KEY  funded Arc-testnet key (gas is native USDC — use https://faucet.circle.com)
///   ORACLE                address of the oracle signer that will call recordResult
/// Optional:
///   USDC_ADDRESS          override the pool token (defaults to Arc canonical USDC)
///
/// Deploy command (from contracts/):
///   forge script script/Deploy.s.sol:Deploy --rpc-url https://rpc.testnet.arc.network --broadcast
///
/// After deploy: record the address and tx hash in DEPLOYMENTS.md and check it
/// on https://testnet.arcscan.app.
contract Deploy is Script {
    /// Arc testnet: native gas is USDC; this is its canonical ERC-20 interface (6 decimals).
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address oracle = vm.envAddress("ORACLE");
        address token = vm.envOr("USDC_ADDRESS", ARC_USDC);

        vm.startBroadcast(deployerKey);
        HealthPools pools = new HealthPools(token, oracle);
        vm.stopBroadcast();

        console.log("HealthPools deployed at:", address(pools));
        console.log("  token (USDC):", token);
        console.log("  oracle:", oracle);
        console.log("  owner:", vm.addr(deployerKey));
    }
}
