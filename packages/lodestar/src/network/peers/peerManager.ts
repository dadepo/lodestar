import {EventEmitter} from "events";
import StrictEventEmitter from "strict-event-emitter-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {Metadata, Ping, Slot, Status} from "@chainsafe/lodestar-types";
import {Goodbye} from "@chainsafe/lodestar-types/src";
import {ILogger, LodestarError} from "@chainsafe/lodestar-utils";
import PeerId from "peer-id";
import {IBeaconChain} from "../../chain";
import {GoodByeReasonCode, GOODBYE_KNOWN_CODES} from "../../constants";
import {IBeaconMetrics} from "../../metrics";
import {IReqResp, ReqRespEvent} from "../reqresp";
import {assertPeerRelevance} from "./assertPeerRelevance";
import {Libp2pPeerMetadataStore} from "./metastore";
import {PeerDiscovery} from "./discover";
import {prioritizePeers} from "./priorization";
import {RequestedSubnet} from "./interface";
import {IPeerRpcScoreStore, ScoreState} from "./score";

export enum PeerManagerEvent {
  peerConnected = "PeerManager-peerConnected",
  peerDisconnected = "PeerManager-peerDisconnected",
}

type PeerManagerEvents = {
  [PeerManagerEvent.peerConnected]: (peer: PeerId, status: Status) => void;
  [PeerManagerEvent.peerDisconnected]: (peer: PeerId) => void;
};

type PeerManagerEmitter = StrictEventEmitter<EventEmitter, PeerManagerEvents>;

/** heartbeat performs regular updates such as updating reputations and performing discovery requests */
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
/** The time in seconds between PING events. We do not send a ping if the other peer has PING'd us */
const PING_INTERVAL_MS = 15 * 1000;

// TODO:
// maxPeers and targetPeers should be dynamic on the num of validators connected
// The Node should compute a recomended value every interval and log a warning
// to terminal if it deviates significantly from the user's settings

type PeerManagerOpts = {
  /** The target number of peers we would like to connect to. */
  targetPeers: number;
  /** The maximum number of peers we allow (exceptions for subnet peers) */
  maxPeers: number;
};

// min_ttl is computed from the subnet highest slot
// if the slot is more than epoch away, add an event to start looking for peers
// add one slot to ensure we keep the peer for the subscription slot
// min_ttl = chain.clock.timeAtSlot(subnet.slot + 1)
// min_ttl is the timestamp at which the subnet can be unsubscribed
// The subnets are request by validators through the API

/**
 * Tasks:
 * - Ping peers every `PING_INTERVAL_MS`
 * - Status peers every `STATUS_INTERVAL_MS`
 * - Execute discovery query if under target peers
 * - Execute discovery query if need peers on some subnet: TODO
 * - Disconnect peers if over target peers
 */
export class PeerManager extends (EventEmitter as {new (): PeerManagerEmitter}) {
  // TODO: Reorg - TEMP
  private libp2p: LibP2p;
  private reqResp: IReqResp;
  private logger: ILogger;
  private metrics: IBeaconMetrics;
  private chain: IBeaconChain;
  private config: IBeaconConfig;
  private peerMetadataStore: Libp2pPeerMetadataStore;
  private peerRpcScores: IPeerRpcScoreStore;
  private discovery: PeerDiscovery;

  /** A collection of inbound and outbound peers awaiting to be Ping'd. */
  private peersToPing = new Map<PeerId, number>();
  /** A collection of peers awaiting to be Status'd. */
  private peersToStatus = new Map<PeerId, number>();
  private opts: PeerManagerOpts;

  /** Map of subnets and the slot until they are needed */
  private subnets = new Map<number, Slot>();

  /** The time in seconds between re-status's peers. */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  private STATUS_INTERVAL_MS: number;

  constructor(
    libp2p: LibP2p,
    reqResp: IReqResp,
    logger: ILogger,
    metrics: IBeaconMetrics,
    chain: IBeaconChain,
    config: IBeaconConfig,
    signal: AbortSignal,
    peerMetadataStore: Libp2pPeerMetadataStore,
    peerRpcScores: IPeerRpcScoreStore,
    opts: PeerManagerOpts
  ) {
    super();
    this.libp2p = libp2p;
    this.reqResp = reqResp;
    this.logger = logger;
    this.metrics = metrics;
    this.chain = chain;
    this.config = config;
    this.peerMetadataStore = peerMetadataStore;
    this.peerRpcScores = peerRpcScores;
    this.opts = opts;

    this.STATUS_INTERVAL_MS = config.params.SLOTS_PER_EPOCH * config.params.SECONDS_PER_SLOT * 1000;

    this.discovery = new PeerDiscovery(libp2p, logger, config, opts);

    // TODO: Connect to peers in the peerstore. Is this done automatically by libp2p?

    libp2p.connectionManager.on("peer:connect", this.onLibp2pPeerConnect);
    libp2p.connectionManager.on("peer:disconnect", this.onLibp2pPeerDisconnect);
    reqResp.on(ReqRespEvent.receivedPing, this.onPing);
    reqResp.on(ReqRespEvent.receivedGoodbye, this.onGoodbye);
    reqResp.on(ReqRespEvent.receivedStatus, this.onStatus);

    const intervalPing = setInterval(() => this.pingAndStatusTimeouts(), 2 * 1000);
    const intervalHeartbeat = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);

    signal.addEventListener("abort", () => {
      libp2p.connectionManager.removeListener("peer:connect", this.onLibp2pPeerConnect);
      libp2p.connectionManager.removeListener("peer:disconnect", this.onLibp2pPeerDisconnect);
      reqResp.off(ReqRespEvent.receivedPing, this.onPing);
      reqResp.off(ReqRespEvent.receivedGoodbye, this.onGoodbye);
      reqResp.off(ReqRespEvent.receivedStatus, this.onStatus);

      clearInterval(intervalPing);
      clearInterval(intervalHeartbeat);
    });
  }

  async goodbyeAndDisconnectAllPeers(): Promise<void> {
    await Promise.all(
      // Filter by peers that support the goodbye protocol: {supportsProtocols: [goodbyeProtocol]}
      this.getConnectedPeerIds().map(async (peer) => this.goodbyeAndDisconnect(peer, GoodByeReasonCode.CLIENT_SHUTDOWN))
    );
  }

  /**
   * Request to find peers on a given subnet.
   */
  requestAttSubnets(requestedSubnets: RequestedSubnet[]): void {
    // Prune expired subnets
    for (const [subnetId, toSlot] of this.subnets.entries()) {
      if (toSlot < this.chain.clock.currentSlot) {
        this.subnets.delete(subnetId);
      }
    }

    // TODO:
    // Only if the slot is more than epoch away, add an event to start looking for peers

    // Register requested subnets
    for (const {subnetId, toSlot} of requestedSubnets) {
      this.subnets.set(subnetId, toSlot);
    }

    // Request to run heartbeat fn
    this.heartbeat();
  }

  /**
   * The app layer needs to refresh the status of some peers. The sync have reached a target
   */
  reStatusPeers(peers: PeerId[]): void {
    for (const peer of peers) this.peersToStatus.set(peer, 0);
    void this.pingAndStatusTimeouts();
  }

  /**
   * Handle a PING request + response (rpc handler responds with PONG automatically)
   */
  private onPing = (peer: PeerId, seqNumber: Ping): void => {
    // reset the to-ping timer for this peer
    this.peersToPing.set(peer, Date.now());

    // if the sequence number is unknown send an update the meta data of the peer.
    const metadata = this.peerMetadataStore.metadata.get(peer);
    if (!metadata || metadata.seqNumber < seqNumber) {
      void this.requestMetadata(peer);
    }
  };

  /**
   * Handle a METADATA request + response (rpc handler responds with METADATA automatically)
   */
  private onMetadata = (peer: PeerId, metadata: Metadata): void => {
    // Store metadata always in case the peer updates attnets but not the sequence number
    // Trust that the peer always sends the latest metadata (From Lighthouse)
    this.peerMetadataStore.metadata.set(peer, metadata);
  };

  /**
   * Handle a GOODBYE request (rpc handler responds automatically)
   */
  private onGoodbye = (peer: PeerId, goodbyeReason: Goodbye): void => {
    const description = GOODBYE_KNOWN_CODES[goodbyeReason.toString()] || "";
    this.logger.verbose("Received goodbye request", {peer: peer.toB58String(), reason: goodbyeReason, description});

    // TODO: Register if we are banned

    void this.disconnect(peer);
  };

  /**
   * Handle a STATUS request + response (rpc handler responds with STATUS automatically)
   */
  private onStatus = async (peer: PeerId, status: Status): Promise<void> => {
    this.peersToStatus.set(peer, Date.now());

    // TODO: Handle rejections
    try {
      await assertPeerRelevance(status, this.chain, this.config);
    } catch (e) {
      this.logger.debug("Irrelevant peer", {
        peer: peer.toB58String(),
        reason: e instanceof LodestarError ? e.getMetadata() : e.message,
      });
      await this.goodbyeAndDisconnect(peer, GoodByeReasonCode.IRRELEVANT_NETWORK);
      return;
    }

    // set status on peer
    // TODO: TEMP code from before
    this.peerMetadataStore.status.set(peer, status);

    // Peer is usable, send it to the rangeSync
    this.emit(PeerManagerEvent.peerConnected, peer, status);
  };

  private async requestMetadata(peer: PeerId): Promise<void> {
    try {
      const metadata = await this.reqResp.metadata(peer);
      this.onMetadata(peer, metadata);
    } catch (e) {
      this.logger.verbose("Error requesting new metadata to peer", {peer: peer.toB58String()}, e);
      // TODO: What to do on error? Should we downvote the peer?
    }
  }

  private async requestStatus(peers: PeerId[]): Promise<void> {
    try {
      const localStatus = this.chain.getStatus();
      await Promise.all(
        peers.map(async (peer) => {
          try {
            const peerStatus = await this.reqResp.status(peer, localStatus);
            await this.onStatus(peer, peerStatus);
          } catch (e) {
            // Failed to get peer latest status
            // TODO: Downvote instead of disconnecting
            await this.disconnect(peer);
          }
        })
      );
    } catch (e) {
      this.logger.verbose("Error requesting new status to peers", {}, e);
    }
  }

  private async requestPing(peer: PeerId): Promise<void> {
    try {
      await this.reqResp.ping(peer);
    } catch (e) {
      this.logger.verbose("Error pinging peer", {peer: peer.toB58String()}, e);
      // TODO: What to do on error? Should we downvote the peer?
    }
  }

  /**
   * The Peer manager's heartbeat maintains the peer count and maintains peer reputations.
   * It will request discovery queries if the peer count has not reached the desired number of peers.
   * NOTE: Discovery should only add a new query if one isn't already queued.
   */
  private heartbeat(): void {
    const connectedPeers = this.getConnectedPeerIds();

    // libp2p autodial
    // (A) on _maybeConnect(), when a peer is discovered
    //  if minConnections > opts.minConnections
    //    await this.dialer.connectToPeer(peerId)
    //
    // (B) every interval, if under minConnections iterate peerStore
    //  and connect to some peers

    // ban and disconnect peers with excesive bad score
    // if score < MIN_SCORE_BEFORE_BAN -> Banned
    // if score < MIN_SCORE_BEFORE_DISCONNECT -> Disconnected
    // else -> Healthy
    const connectedHealthPeers: PeerId[] = [];
    for (const peer of connectedPeers) {
      switch (this.peerRpcScores.getScoreState(peer)) {
        case ScoreState.Banned:
          void this.goodbyeAndDisconnect(peer, GoodByeReasonCode.BANNED);
          break;
        case ScoreState.Disconnected:
          void this.goodbyeAndDisconnect(peer, GoodByeReasonCode.SCORE_TOO_LOW);
          break;
        case ScoreState.Healthy:
          connectedHealthPeers.push(peer);
      }
    }

    // Collect subnets which we need peers for in the current slot
    const activeSubnetIds: number[] = [];
    for (const [subnetId, toSlot] of this.subnets.entries()) {
      if (toSlot >= this.chain.clock.currentSlot) {
        activeSubnetIds.push(subnetId);
      }
    }

    const {peersToDisconnect, discv5Queries, peersToConnect} = prioritizePeers(
      connectedPeers.map((peer) => ({
        id: peer,
        attnets: this.peerMetadataStore.metadata.get(peer)?.attnets || [],
        score: this.peerMetadataStore.rpcScore.get(peer) || 0,
      })),
      activeSubnetIds,
      this.opts
    );

    if (discv5Queries.length > 0) {
      // It's a promise due to crypto lib calls only
      void this.discovery.discoverSubnetPeers(discv5Queries);
    }

    if (peersToConnect > 0) {
      this.discovery.discoverPeers(peersToConnect);
    }

    for (const peer of peersToDisconnect) {
      void this.goodbyeAndDisconnect(peer, GoodByeReasonCode.TOO_MANY_PEERS);
    }
  }

  private pingAndStatusTimeouts(): void {
    // Every interval request to send some peers our seqNumber and process theirs
    // If the seqNumber is different it must request the new metadata
    for (const [peer, lastMs] of this.peersToPing.entries()) {
      if (Date.now() - lastMs > PING_INTERVAL_MS) {
        this.peersToPing.set(peer, Date.now());
        void this.requestPing(peer);
      }
    }

    // TODO: Consider sending status request to peers that do support status protocol
    // {supportsProtocols: getStatusProtocols()}

    // Every interval request to send some peers our status, and process theirs
    // Must re-check if this peer is relevant to us and emit an event if the status changes
    // So the sync layer can update things
    const peersToStatus: PeerId[] = [];
    for (const [peer, lastMs] of this.peersToStatus.entries()) {
      if (Date.now() - lastMs > this.STATUS_INTERVAL_MS) {
        this.peersToStatus.set(peer, Date.now());
        peersToStatus.push(peer);
      }
    }

    if (peersToStatus.length > 0) {
      void this.requestStatus(peersToStatus);
    }
  }

  /**
   * The libp2p Upgrader has successfully upgraded a peer connection on a particular multiaddress
   * This event is routed through the connectionManager
   *
   * Registers a peer as connected. The `direction` parameter determines if the peer is being
   * dialed or connecting to us.
   */
  private onLibp2pPeerConnect = (libp2pConnection: LibP2pConnection): void => {
    const {direction, status} = libp2pConnection.stat;
    const peer = libp2pConnection.remotePeer;

    // TODO: store peer in DB

    // start a ping and status timer for the peer
    this.peersToStatus.set(peer, 0);
    this.peersToPing.set(peer, 0);

    // TODO: increment prometheus metrics
    this.metrics.peers.set(this.getConnectedPeerIds().length);
    this.logger.verbose("peer connected", {peerId: peer.toB58String(), direction, status});
    // Don't emit the peerConnect event here, but after validating the status
  };

  /**
   * The libp2p Upgrader has ended a connection
   */
  private onLibp2pPeerDisconnect = (libp2pConnection: LibP2pConnection): void => {
    const {direction, status} = libp2pConnection.stat;
    const peer = libp2pConnection.remotePeer;

    // TODO: Remove peer from DB

    // remove the ping and status timer for the peer
    this.peersToPing.delete(peer);
    this.peersToStatus.delete(peer);

    this.libp2p.connectionManager.connections;

    this.metrics.peers.set(this.getConnectedPeerIds().length);
    this.logger.verbose("peer disconnected", {peerId: peer.toB58String(), direction, status});
    this.emit(PeerManagerEvent.peerDisconnected, peer);
  };

  /**
   * Return peers with at least one connection in status "open"
   */
  private getConnectedPeerIds(): PeerId[] {
    const peerIds: PeerId[] = [];
    for (const connections of this.libp2p.connectionManager.connections.values()) {
      const openConnection = connections.find((connection) => connection.stat.status === "open");
      if (openConnection) {
        peerIds.push(openConnection.remotePeer);
      }
    }
    return peerIds;
  }

  private async disconnect(peerId: PeerId): Promise<void> {
    try {
      await this.libp2p.hangUp(peerId);
    } catch (e) {
      this.logger.warn("Unclean disconnect", {reason: e.message});
    }
  }

  private async goodbyeAndDisconnect(peer: PeerId, reason: GoodByeReasonCode): Promise<void> {
    try {
      await this.reqResp.goodbye(peer, BigInt(reason));
    } catch (e) {
      this.logger.verbose("Failed to send goodbye", {error: e.message});
      await this.disconnect(peer);
    }
  }
}
