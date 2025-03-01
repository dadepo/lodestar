import {AbortController} from "@chainsafe/abort-controller";
import {IChainConfig} from "@chainsafe/lodestar-config";
import {sleep} from "@chainsafe/lodestar-utils";
import {fromHexString} from "@chainsafe/ssz";
import {expect} from "chai";
import {Eth1Provider, IEth1Provider} from "../../../src";
import {Eth1MergeBlockTracker, StatusCode} from "../../../src/eth1/eth1MergeBlockTracker";
import {Eth1Options} from "../../../src/eth1/options";
import {testLogger} from "../../utils/logger";
import {quantityToBigint} from "../../../src/eth1/provider/utils";
import {ZERO_HASH} from "../../../src/constants";
import {getGoerliRpcUrl} from "../../testParams";

/* eslint-disable @typescript-eslint/naming-convention */

describe("eth1 / Eth1MergeBlockTracker", function () {
  this.timeout("2 min");

  const logger = testLogger();

  function getConfig(ttd: bigint): IChainConfig {
    return ({
      // Set time units to 1s to make the test faster
      SECONDS_PER_ETH1_BLOCK: 1,
      SECONDS_PER_SLOT: 1,
      DEPOSIT_CONTRACT_ADDRESS: Buffer.alloc(32, 0),
      TERMINAL_TOTAL_DIFFICULTY: ttd,
      TERMINAL_BLOCK_HASH: ZERO_HASH,
    } as Partial<IChainConfig>) as IChainConfig;
  }
  const eth1Config = {DEPOSIT_CONTRACT_ADDRESS: ZERO_HASH};

  // Compute lazily since getGoerliRpcUrl() throws if GOERLI_RPC_URL is not set
  let eth1Options: Eth1Options;
  before("Get eth1Options", () => {
    eth1Options = {
      enabled: true,
      providerUrls: [getGoerliRpcUrl()],
      depositContractDeployBlock: 0,
    };
  });

  let controller: AbortController;
  beforeEach(() => (controller = new AbortController()));
  afterEach(() => controller.abort());

  it("Should find terminal pow block through TERMINAL_BLOCK_HASH", async () => {
    const eth1Provider = new Eth1Provider(eth1Config, eth1Options, controller.signal);
    const latestBlock = await eth1Provider.getBlockByNumber("latest");
    if (!latestBlock) throw Error("No latestBlock");
    const terminalTotalDifficulty = quantityToBigint(latestBlock.totalDifficulty) - BigInt(1000);
    const config = getConfig(terminalTotalDifficulty);
    config.TERMINAL_BLOCK_HASH = fromHexString(latestBlock.hash);
    const eth1MergeBlockTracker = new Eth1MergeBlockTracker(
      {
        config,
        logger,
        signal: controller.signal,
        clockEpoch: 0,
        isMergeComplete: false,
      },
      eth1Provider as IEth1Provider
    );

    // Wait for Eth1MergeBlockTracker to find at least one merge block
    while (!controller.signal.aborted) {
      if (eth1MergeBlockTracker.getTerminalPowBlock()) break;
      await sleep(500, controller.signal);
    }

    // Status should acknowlege merge block is found
    expect(eth1MergeBlockTracker["status"]).to.equal(StatusCode.FOUND, "Wrong StatusCode");

    // Given the total difficulty offset the block that has TTD is the `difficultyOffset`nth block
    const mergeBlock = eth1MergeBlockTracker.getTerminalPowBlock();
    if (!mergeBlock) throw Error("terminal pow block not found");
    expect(mergeBlock.totalDifficulty).to.equal(
      quantityToBigint(latestBlock.totalDifficulty),
      "terminalPowBlock.totalDifficulty is not correct"
    );
  });

  it("Should find merge block polling future 'latest' blocks", async () => {
    const eth1Provider = new Eth1Provider(eth1Config, eth1Options, controller.signal);
    const latestBlock = await eth1Provider.getBlockByNumber("latest");
    if (!latestBlock) throw Error("No latestBlock");

    // Set TTD to current totalDifficulty + 1, so the next block is the merge block
    const terminalTotalDifficulty = quantityToBigint(latestBlock.totalDifficulty) + BigInt(1);

    const eth1MergeBlockTracker = new Eth1MergeBlockTracker(
      {
        config: getConfig(terminalTotalDifficulty),
        logger,
        signal: controller.signal,
        clockEpoch: 0,
        isMergeComplete: false,
      },
      eth1Provider as IEth1Provider
    );

    // Wait for Eth1MergeBlockTracker to find at least one merge block
    while (!controller.signal.aborted) {
      if (eth1MergeBlockTracker.getTerminalPowBlock()) break;
      await sleep(500, controller.signal);
    }

    // Status should acknowlege merge block is found
    expect(eth1MergeBlockTracker["status"]).to.equal(StatusCode.FOUND, "Wrong StatusCode");

    // Given the total difficulty offset the block that has TTD is the `difficultyOffset`nth block
    const mergeBlock = eth1MergeBlockTracker.getTerminalPowBlock();
    if (!mergeBlock) throw Error("mergeBlock not found");
    expect(mergeBlock.totalDifficulty >= terminalTotalDifficulty).to.equal(
      true,
      "mergeBlock.totalDifficulty is not >= TTD"
    );
  });

  it("Should find merge block fetching past blocks", async () => {
    const eth1Provider = new Eth1Provider(eth1Config, eth1Options, controller.signal);
    const latestBlock = await eth1Provider.getBlockByNumber("latest");
    if (!latestBlock) throw Error("No latestBlock");

    // Set TTD to current totalDifficulty + 1, so the previous block is the merge block
    const terminalTotalDifficulty = quantityToBigint(latestBlock.totalDifficulty) - BigInt(1);

    const eth1MergeBlockTracker = new Eth1MergeBlockTracker(
      {
        config: getConfig(terminalTotalDifficulty),
        logger,
        signal: controller.signal,
        clockEpoch: 0,
        isMergeComplete: false,
      },
      eth1Provider as IEth1Provider
    );

    // Wait for Eth1MergeBlockTracker to find at least one merge block
    while (!controller.signal.aborted) {
      if (eth1MergeBlockTracker.getTerminalPowBlock()) break;
      await sleep(500, controller.signal);
    }

    // Status should acknowlege merge block is found
    expect(eth1MergeBlockTracker["status"]).to.equal(StatusCode.FOUND, "Wrong StatusCode");

    // Given the total difficulty offset the block that has TTD is the `difficultyOffset`nth block
    const mergeBlock = eth1MergeBlockTracker.getTerminalPowBlock();
    if (!mergeBlock) throw Error("mergeBlock not found");
    expect(mergeBlock.totalDifficulty >= terminalTotalDifficulty).to.equal(
      true,
      "mergeBlock.totalDifficulty is not >= TTD"
    );
  });
});
