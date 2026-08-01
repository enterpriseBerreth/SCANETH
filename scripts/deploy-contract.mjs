#!/usr/bin/env node
/**
 * Compile and deploy ArboFlashArb.
 *
 * Uses the `solc` npm package plus ethers, so no Foundry or Hardhat toolchain is
 * required. Kept out of the runtime dependency set — the Railway worker never
 * needs a compiler.
 *
 * Usage:
 *   node scripts/deploy-contract.mjs --chain base
 *   node scripts/deploy-contract.mjs --chain base --compile-only
 *
 * Requires DEPLOYER_PRIVATE_KEY (or EXECUTOR_PRIVATE_KEY) and the chain's RPC
 * URL in the environment. The deploying address becomes the contract owner, and
 * must be the same address ARBO later trades with.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ContractFactory, JsonRpcProvider, Wallet, formatEther, formatUnits } from 'ethers';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const solc = require('solc');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CONTRACT_FILE = 'ArboFlashArb.sol';
const CONTRACT_NAME = 'ArboFlashArb';

/**
 * Chain constants. Must match src/chains.ts.
 * Aave V3 Pool and Balancer V2 Vault per network.
 */
const CHAINS = {
  base: {
    chainId: 8453,
    rpcEnv: 'BASE_RPC_URL',
    defaultRpc: 'https://mainnet.base.org',
    aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    envVar: 'ARB_CONTRACT_BASE',
    explorer: 'https://basescan.org/address/',
  },
  arbitrum: {
    chainId: 42161,
    rpcEnv: 'ARBITRUM_RPC_URL',
    defaultRpc: 'https://arb1.arbitrum.io/rpc',
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    envVar: 'ARB_CONTRACT_ARBITRUM',
    explorer: 'https://arbiscan.io/address/',
  },
  ethereum: {
    chainId: 1,
    rpcEnv: 'ETHEREUM_RPC_URL',
    defaultRpc: 'https://eth.llamarpc.com',
    aavePool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    balancerVault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    envVar: 'ARB_CONTRACT_ETHEREUM',
    explorer: 'https://etherscan.io/address/',
  },
};

function parseArgs(argv) {
  const args = { chain: 'base', compileOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--chain' && argv[i + 1]) {
      args.chain = argv[i + 1].toLowerCase();
      i += 1;
    } else if (arg === '--compile-only') {
      args.compileOnly = true;
    }
  }
  return args;
}

function compile() {
  const source = readFileSync(join(root, 'contracts', CONTRACT_FILE), 'utf8');

  const input = {
    language: 'Solidity',
    sources: { [CONTRACT_FILE]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 1_000_000 },
      // Arbitrage margins are thin, so optimise aggressively for runtime gas
      // rather than deployment size.
      evmVersion: 'paris',
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
  const warnings = (output.errors ?? []).filter((e) => e.severity === 'warning');

  for (const warning of warnings) {
    console.log(`  warning: ${warning.formattedMessage?.trim() ?? warning.message}`);
  }

  if (errors.length > 0) {
    console.error('\nCompilation failed:\n');
    for (const error of errors) {
      console.error(error.formattedMessage ?? error.message);
    }
    process.exit(1);
  }

  const artifact = output.contracts?.[CONTRACT_FILE]?.[CONTRACT_NAME];
  if (!artifact) {
    console.error(`Compiler produced no artifact for ${CONTRACT_NAME}`);
    process.exit(1);
  }

  const bytecode = `0x${artifact.evm.bytecode.object}`;
  const deployedSize = (artifact.evm.deployedBytecode.object.length / 2) | 0;

  const outDir = join(root, 'contracts', 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${CONTRACT_NAME}.json`),
    JSON.stringify({ abi: artifact.abi, bytecode }, null, 2),
  );

  console.log(`  compiled ${CONTRACT_NAME}`);
  console.log(`  solc version   : ${solc.version()}`);
  console.log(`  runtime size   : ${deployedSize} bytes (limit 24576)`);
  console.log(`  artifact       : contracts/out/${CONTRACT_NAME}.json`);

  return { abi: artifact.abi, bytecode };
}

async function main() {
  const { chain: chainName, compileOnly } = parseArgs(process.argv);

  const chain = CHAINS[chainName];
  if (!chain) {
    console.error(
      `Unknown chain "${chainName}". Supported: ${Object.keys(CHAINS).join(', ')}`,
    );
    process.exit(1);
  }

  console.log(`\n=== Deploy ${CONTRACT_NAME} -> ${chainName} ===\n`);

  const { abi, bytecode } = compile();

  if (compileOnly) {
    console.log('\ncompile-only requested, stopping here.\n');
    return;
  }

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.EXECUTOR_PRIVATE_KEY;
  if (!privateKey) {
    console.error(
      '\nMissing DEPLOYER_PRIVATE_KEY (or EXECUTOR_PRIVATE_KEY).\n' +
        'The deploying account becomes the contract owner and must be the same\n' +
        'account ARBO trades with.\n',
    );
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    console.error('\nPrivate key must be a 0x-prefixed 32-byte hex string.\n');
    process.exit(1);
  }

  const rpcUrl = process.env[chain.rpcEnv] ?? chain.defaultRpc;
  const provider = new JsonRpcProvider(rpcUrl, chain.chainId, { staticNetwork: true });
  const wallet = new Wallet(privateKey, provider);

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chain.chainId) {
    console.error(
      `\nRPC chain id mismatch: expected ${chain.chainId}, got ${network.chainId}.\n` +
        `Check ${chain.rpcEnv}.\n`,
    );
    process.exit(1);
  }

  const balance = await provider.getBalance(wallet.address);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;

  console.log(`\n  deployer       : ${wallet.address}`);
  console.log(`  balance        : ${formatEther(balance)} ETH`);
  console.log(`  gas price      : ${formatUnits(gasPrice, 'gwei')} gwei`);
  console.log(`  aave pool      : ${chain.aavePool}`);
  console.log(`  balancer vault : ${chain.balancerVault}`);

  if (balance === 0n) {
    console.error('\nDeployer has no balance — fund it before deploying.\n');
    process.exit(1);
  }

  const factory = new ContractFactory(abi, bytecode, wallet);

  const deployTx = await factory.getDeployTransaction(chain.aavePool, chain.balancerVault);
  let estimatedGas;
  try {
    estimatedGas = await provider.estimateGas({ ...deployTx, from: wallet.address });
    const cost = estimatedGas * gasPrice;
    console.log(`  est. deploy gas: ${estimatedGas} (~${formatEther(cost)} ETH)`);
    if (cost > balance) {
      console.error('\nInsufficient balance to cover deployment gas.\n');
      process.exit(1);
    }
  } catch (err) {
    console.log(`  gas estimation failed: ${err instanceof Error ? err.message : err}`);
  }

  console.log('\n  deploying...');
  const contract = await factory.deploy(chain.aavePool, chain.balancerVault);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log(`\n  DEPLOYED: ${address}`);
  console.log(`  explorer: ${chain.explorer}${address}`);
  console.log(`\n  Next step — add this to your environment (and to Railway):`);
  console.log(`    ${chain.envVar}=${address}`);
  console.log(
    `\n  ARBO stays in scan-only mode until MODE=live and EXECUTOR_PRIVATE_KEY` +
      `\n  are also set. The executor key must be ${wallet.address}.\n`,
  );
}

main().catch((err) => {
  console.error('\nDeployment failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
