import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { L2Book, TradeData, UserEvent, HyperliquidCandle } from './types';

// Mainnet WebSocket URL
const MAINNET_WS_URL = 'wss://api.hyperliquid.xyz/ws';

// Testnet WebSocket URL
const TESTNET_WS_URL = 'wss://api.hyperliquid-testnet.xyz/ws';

interface Subscription {
  method: string;
  subscription: {
    type: string;
    coin?: string;
    interval?: string;
    user?: string;
  };
}

export class HyperliquidWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private subscriptions: Map<string, Subscription> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private wsUrl: string;

  constructor(useTestnet: boolean = false) {
    super();
    this.wsUrl = useTestnet ? TESTNET_WS_URL : MAINNET_WS_URL;
  }

  async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        console.log('[WS] Connected to Hyperliquid');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.startPing();
        this.resubscribe();
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error('[WS] Failed to parse message:', error);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[WS] Disconnected: ${code} - ${reason.toString()}`);
        this.isConnecting = false;
        this.stopPing();
        this.handleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('[WS] Error:', error);
        this.isConnecting = false;
        reject(error);
      });

      this.ws.on('pong', () => {
        // Connection is alive
      });
    });
  }

  private handleMessage(message: { channel?: string; data?: unknown }): void {
    const { channel, data } = message;

    if (!channel) {
      // Subscription confirmation or other non-channel message
      this.emit('message', message);
      return;
    }

    switch (channel) {
      case 'trades':
        this.emit('trades', data as TradeData);
        break;
      case 'l2Book':
        this.emit('orderbook', data as L2Book);
        break;
      case 'candle':
        this.emit('candle', data as HyperliquidCandle);
        break;
      case 'userEvents':
        this.emit('userEvents', data as UserEvent);
        break;
      case 'allMids':
        this.emit('allMids', data as Record<string, string>);
        break;
      default:
        this.emit('message', message);
    }
  }

  subscribeTrades(coin: string): void {
    const sub: Subscription = {
      method: 'subscribe',
      subscription: { type: 'trades', coin },
    };
    this.subscriptions.set(`trades:${coin}`, sub);
    this.send(sub);
  }

  unsubscribeTrades(coin: string): void {
    const key = `trades:${coin}`;
    const sub = this.subscriptions.get(key);
    if (sub) {
      this.send({ method: 'unsubscribe', subscription: sub.subscription });
      this.subscriptions.delete(key);
    }
  }

  subscribeOrderbook(coin: string): void {
    const sub: Subscription = {
      method: 'subscribe',
      subscription: { type: 'l2Book', coin },
    };
    this.subscriptions.set(`l2Book:${coin}`, sub);
    this.send(sub);
  }

  subscribeCandles(coin: string, interval: string): void {
    const sub: Subscription = {
      method: 'subscribe',
      subscription: { type: 'candle', coin, interval },
    };
    this.subscriptions.set(`candle:${coin}:${interval}`, sub);
    this.send(sub);
  }

  subscribeUserEvents(address: string): void {
    // IMPORTANT: Address must be lowercase per Hyperliquid docs
    const userAddress = address.toLowerCase();
    const sub: Subscription = {
      method: 'subscribe',
      subscription: { type: 'userEvents', user: userAddress },
    };
    this.subscriptions.set(`userEvents:${userAddress}`, sub);
    this.send(sub);
  }

  subscribeAllMids(): void {
    const sub: Subscription = {
      method: 'subscribe',
      subscription: { type: 'allMids' },
    };
    this.subscriptions.set('allMids', sub);
    this.send(sub);
  }

  private send(data: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private resubscribe(): void {
    for (const sub of this.subscriptions.values()) {
      this.send(sub);
    }
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      setTimeout(() => this.connect().catch(console.error), delay);
    } else {
      console.error('[WS] Max reconnection attempts reached');
      this.emit('maxReconnectReached');
    }
  }

  disconnect(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscriptions.clear();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
