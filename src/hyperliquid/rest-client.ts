import axios, { AxiosInstance, AxiosError } from 'axios';
import { HyperliquidAuth } from './auth';
import {
  HyperliquidMeta,
  HyperliquidAccountInfo,
  HyperliquidOpenOrder,
  HyperliquidFill,
  HyperliquidFundingHistory,
  HyperliquidCandle,
  OrderRequest,
  OrderResponse,
  CancelResponse,
  AssetContext,
  MetaAndAssetCtxsResponse,
} from './types';
import {
  logger,
  hyperliquidRateLimiter,
  withRetry,
  NetworkError,
  RateLimitError,
  healthChecker,
  createApiHealthCheck,
} from '../utils';

// Mainnet URLs
const MAINNET_INFO_URL = 'https://api.hyperliquid.xyz/info';
const MAINNET_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';

// Testnet URLs
const TESTNET_INFO_URL = 'https://api.hyperliquid-testnet.xyz/info';
const TESTNET_EXCHANGE_URL = 'https://api.hyperliquid-testnet.xyz/exchange';

export class HyperliquidRestClient {
  private client: AxiosInstance;
  private auth: HyperliquidAuth;
  private assetIndexMap: Map<string, number> = new Map();
  private assetSzDecimalsMap: Map<string, number> = new Map();  // Size decimals per asset
  private meta: HyperliquidMeta | null = null;
  private infoUrl: string;
  private exchangeUrl: string;
  private useTestnet: boolean;

  constructor(auth: HyperliquidAuth, useTestnet: boolean = false) {
    this.auth = auth;
    this.useTestnet = useTestnet;
    this.infoUrl = useTestnet ? TESTNET_INFO_URL : MAINNET_INFO_URL;
    this.exchangeUrl = useTestnet ? TESTNET_EXCHANGE_URL : MAINNET_EXCHANGE_URL;

    logger.info('Hyperliquid', `Using ${useTestnet ? 'TESTNET' : 'MAINNET'} API`);

    this.client = axios.create({
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Add request interceptor for logging
    this.client.interceptors.request.use((config) => {
      (config as any).metadata = { startTime: Date.now() };
      return config;
    });

    // Add response interceptor for logging and error handling
    this.client.interceptors.response.use(
      (response) => {
        const latency = Date.now() - (response.config as any).metadata.startTime;
        logger.debug('Hyperliquid', 'API request completed', {
          url: response.config.url,
          status: response.status,
          latencyMs: latency,
        });
        return response;
      },
      (error: AxiosError) => {
        const latency = error.config ? Date.now() - (error.config as any).metadata?.startTime : 0;
        logger.error('Hyperliquid', 'API request failed', {
          url: error.config?.url,
          status: error.response?.status,
          latencyMs: latency,
          error: error.message,
        });

        // Convert to appropriate error type
        if (error.response?.status === 429) {
          const retryAfter = parseInt(error.response.headers['retry-after'] || '60', 10) * 1000;
          throw new RateLimitError(retryAfter);
        }

        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          throw new NetworkError(`Request timeout: ${error.message}`);
        }

        if (!error.response) {
          throw new NetworkError(`Network error: ${error.message}`);
        }

        throw error;
      }
    );

    // Register health check
    healthChecker.registerCheck(
      'hyperliquid-api',
      createApiHealthCheck('hyperliquid-api', async () => {
        try {
          await this.getAllMids();
          return true;
        } catch {
          return false;
        }
      })
    );
  }

  // Rate-limited request helper
  private async request<T>(endpoint: string, data: unknown, isExchange: boolean = false): Promise<T> {
    await hyperliquidRateLimiter.acquire(endpoint);

    const url = isExchange ? this.exchangeUrl : this.infoUrl;
    const response = await this.client.post(url, data);
    return response.data;
  }

  // Request with retry logic
  private async requestWithRetry<T>(
    endpoint: string,
    data: unknown,
    isExchange: boolean = false
  ): Promise<T> {
    const result = await withRetry(
      () => this.request<T>(endpoint, data, isExchange),
      `Hyperliquid.${endpoint}`,
      { maxAttempts: 3, initialDelayMs: 1000 }
    );

    if (!result.success) {
      throw result.error;
    }

    return result.data!;
  }

  // ===== INITIALIZATION =====

  async initialize(): Promise<void> {
    this.meta = await this.getMeta();
    this.meta.universe.forEach((asset, index) => {
      this.assetIndexMap.set(asset.name, index);
      this.assetSzDecimalsMap.set(asset.name, asset.szDecimals);
    });
    logger.info('Hyperliquid', 'Initialized', { assets: this.assetIndexMap.size });
  }

  getSzDecimals(coin: string): number {
    return this.assetSzDecimalsMap.get(coin) ?? 8;  // Default to 8 if not found
  }

  // ===== INFO ENDPOINTS =====

  async getMeta(): Promise<HyperliquidMeta> {
    return this.requestWithRetry('meta', { type: 'meta' });
  }

  /**
   * Get metadata and asset contexts including open interest, mark price, funding, etc.
   */
  async getMetaAndAssetCtxs(): Promise<MetaAndAssetCtxsResponse> {
    const [meta, assetCtxs] = await this.requestWithRetry<[HyperliquidMeta, AssetContext[]]>(
      'metaAndAssetCtxs',
      { type: 'metaAndAssetCtxs' }
    );
    return { meta, assetCtxs };
  }

  /**
   * Get asset contexts (open interest, funding, mark price, etc.) for all assets
   */
  async getAssetContexts(): Promise<AssetContext[]> {
    const response = await this.getMetaAndAssetCtxs();
    return response.assetCtxs;
  }

  async getAllMids(): Promise<Record<string, string>> {
    return this.requestWithRetry('allMids', { type: 'allMids' });
  }

  async getAccountState(address?: string): Promise<HyperliquidAccountInfo> {
    // IMPORTANT: Address must be lowercase per Hyperliquid docs
    const userAddress = (address || this.auth.address).toLowerCase();
    return this.requestWithRetry('clearinghouseState', {
      type: 'clearinghouseState',
      user: userAddress,
    });
  }

  async getOpenOrders(address?: string): Promise<HyperliquidOpenOrder[]> {
    const userAddress = (address || this.auth.address).toLowerCase();
    return this.requestWithRetry('openOrders', {
      type: 'openOrders',
      user: userAddress,
    });
  }

  async getUserFills(address?: string): Promise<HyperliquidFill[]> {
    const userAddress = (address || this.auth.address).toLowerCase();
    return this.requestWithRetry('userFills', {
      type: 'userFills',
      user: userAddress,
    });
  }

  /**
   * Get user fills with time-based pagination (up to 10000 most recent)
   * Returns at most 2000 fills per response
   */
  async getUserFillsByTime(
    startTime: number,
    endTime?: number,
    aggregateByTime?: boolean,
    address?: string
  ): Promise<HyperliquidFill[]> {
    const userAddress = (address || this.auth.address).toLowerCase();
    return this.requestWithRetry('userFillsByTime', {
      type: 'userFillsByTime',
      user: userAddress,
      startTime,
      endTime: endTime || Date.now(),
      aggregateByTime: aggregateByTime || false,
    });
  }

  /**
   * Get historical orders (up to 2000 most recent)
   */
  async getHistoricalOrders(address?: string): Promise<HyperliquidOpenOrder[]> {
    const userAddress = (address || this.auth.address).toLowerCase();
    return this.requestWithRetry('historicalOrders', {
      type: 'historicalOrders',
      user: userAddress,
    });
  }

  async getFundingHistory(
    coin: string,
    startTime: number,
    endTime?: number
  ): Promise<HyperliquidFundingHistory[]> {
    return this.requestWithRetry('fundingHistory', {
      type: 'fundingHistory',
      coin,
      startTime,
      endTime: endTime || Date.now(),
    });
  }

  async getCandles(
    coin: string,
    interval: string,
    startTime: number,
    endTime?: number
  ): Promise<HyperliquidCandle[]> {
    return this.requestWithRetry('candleSnapshot', {
      type: 'candleSnapshot',
      req: {
        coin,
        interval,
        startTime,
        endTime: endTime || Date.now(),
      },
    });
  }

  async getL2Book(coin: string): Promise<{ levels: [{ px: string; sz: string }[], { px: string; sz: string }[]] }> {
    return this.requestWithRetry('l2Book', {
      type: 'l2Book',
      coin,
    });
  }

  // ===== EXCHANGE ENDPOINTS =====

  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    const nonce = Date.now();
    const action = {
      type: 'order',
      orders: [
        {
          a: order.asset,
          b: order.isBuy,
          p: this.formatPrice(order.price),
          s: this.formatSize(order.size),
          r: order.reduceOnly || false,
          t: order.orderType || { limit: { tif: 'Gtc' } },
        },
      ],
      grouping: 'na',
    };

    const signature = await this.auth.signL1Action(action, nonce);

    logger.trade('Place order', {
      asset: order.asset,
      side: order.isBuy ? 'BUY' : 'SELL',
      price: order.price,
      size: order.size,
      reduceOnly: order.reduceOnly,
      formattedPrice: this.formatPrice(order.price),
      formattedSize: this.formatSize(order.size),
    });

    // Log the full request for debugging
    const requestPayload = {
      action,
      nonce,
      signature,
    };
    logger.debug('Hyperliquid', 'Order request payload', { payload: JSON.stringify(requestPayload) });

    // Exchange requests should not use retry - order might have been placed
    try {
      const response = await this.request<OrderResponse>('order', requestPayload, true);
      logger.debug('Hyperliquid', 'Order response', { response: JSON.stringify(response) });
      return response;
    } catch (error: unknown) {
      // Log detailed error info
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as { response?: { data?: unknown; status?: number } };
        logger.error('Hyperliquid', 'Order request failed', {
          status: axiosError.response?.status,
          data: JSON.stringify(axiosError.response?.data),
        });
      }
      throw error;
    }
  }

  async placeMarketOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    reduceOnly: boolean = false
  ): Promise<OrderResponse> {
    logger.debug('Hyperliquid', 'placeMarketOrder called', { coin, isBuy, size, reduceOnly });

    const mids = await this.getAllMids();
    const midPrice = parseFloat(mids[coin]);

    if (!midPrice || isNaN(midPrice)) {
      logger.error('Hyperliquid', 'Invalid mid price', { coin, midPrice, mids: mids[coin] });
      throw new Error(`Invalid mid price for ${coin}: ${mids[coin]}`);
    }

    // For market orders, use a price that will fill immediately
    // Using slippagePrice to match SDK's 5 significant figure rounding
    const slippage = 0.01; // 1%
    const price = this.slippagePrice(isBuy, slippage, midPrice);

    const assetIndex = this.coinToAssetIndex(coin);
    const szDecimals = this.getSzDecimals(coin);

    // Round size to asset-specific decimals
    const roundedSize = this.roundToDecimals(size, szDecimals);

    logger.trade('Place market order', {
      coin,
      side: isBuy ? 'BUY' : 'SELL',
      size,
      roundedSize,
      szDecimals,
      midPrice,
      price,
      assetIndex,
      slippage: `${slippage * 100}%`,
    });

    return this.placeOrder({
      asset: assetIndex,
      isBuy,
      price,
      size: roundedSize,
      reduceOnly,
      orderType: { limit: { tif: 'Ioc' } }, // Immediate-or-cancel for market-like behavior
    });
  }

  private roundToDecimals(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.floor(value * factor) / factor;  // Floor to avoid over-buying
  }

  /**
   * Calculate slippage price matching Python SDK's slippage_price()
   * Applies slippage and rounds to 5 significant figures
   */
  private slippagePrice(isBuy: boolean, slippage: number, px: number): number {
    const adjustedPx = isBuy ? px * (1 + slippage) : px * (1 - slippage);
    return this.roundToSigFigs(adjustedPx, 5);
  }

  /**
   * Round to N significant figures matching Python SDK's round_float()
   */
  private roundToSigFigs(x: number, sigFigs: number): number {
    if (x === 0) return 0;
    const magnitude = Math.floor(Math.log10(Math.abs(x)));
    const scale = Math.pow(10, sigFigs - magnitude - 1);
    return Math.round(x * scale) / scale;
  }

  async cancelOrder(coin: string, oid: number): Promise<CancelResponse> {
    const nonce = Date.now();
    const action = {
      type: 'cancel',
      cancels: [{ a: this.coinToAssetIndex(coin), o: oid }],
    };

    const signature = await this.auth.signL1Action(action, nonce);

    logger.trade('Cancel order', { coin, orderId: oid });

    return this.request('cancel', {
      action,
      nonce,
      signature,
    }, true);
  }

  async cancelAllOrders(): Promise<CancelResponse> {
    const orders = await this.getOpenOrders();
    if (orders.length === 0) {
      return { status: 'ok' };
    }

    const nonce = Date.now();
    const cancels = orders.map((order) => ({
      a: this.coinToAssetIndex(order.coin),
      o: order.oid,
    }));

    const action = {
      type: 'cancel',
      cancels,
    };

    const signature = await this.auth.signL1Action(action, nonce);

    logger.trade('Cancel all orders', { count: orders.length });

    return this.request('cancelAll', {
      action,
      nonce,
      signature,
    }, true);
  }

  async updateLeverage(
    coin: string,
    leverage: number,
    isCross: boolean = true
  ): Promise<{ status: string }> {
    const nonce = Date.now();
    const action = {
      type: 'updateLeverage',
      asset: this.coinToAssetIndex(coin),
      isCross,
      leverage,
    };

    const signature = await this.auth.signL1Action(action, nonce);

    logger.debug('Hyperliquid', 'Update leverage', { coin, leverage, isCross });

    return this.request('updateLeverage', {
      action,
      nonce,
      signature,
    }, true);
  }

  async closePosition(coin: string): Promise<OrderResponse> {
    const accountState = await this.getAccountState();
    const position = accountState.assetPositions.find(
      (p) => p.position.coin === coin && parseFloat(p.position.szi) !== 0
    );

    if (!position) {
      logger.debug('Hyperliquid', 'No position to close', { coin });
      return { status: 'ok' };
    }

    const size = Math.abs(parseFloat(position.position.szi));
    const isLong = parseFloat(position.position.szi) > 0;

    logger.trade('Close position', {
      coin,
      side: isLong ? 'LONG' : 'SHORT',
      size,
    });

    return this.placeMarketOrder(coin, !isLong, size, true);
  }

  async closeAllPositions(): Promise<OrderResponse[]> {
    const accountState = await this.getAccountState();
    const results: OrderResponse[] = [];

    const positionsToClose = accountState.assetPositions.filter(
      (p) => parseFloat(p.position.szi) !== 0
    );

    logger.trade('Close all positions', { count: positionsToClose.length });

    for (const pos of positionsToClose) {
      const result = await this.closePosition(pos.position.coin);
      results.push(result);
    }

    return results;
  }

  // ===== UTILITY =====

  coinToAssetIndex(coin: string): number {
    const index = this.assetIndexMap.get(coin);
    if (index === undefined) {
      throw new Error(`Unknown coin: ${coin}. Call initialize() first.`);
    }
    return index;
  }

  getAssetSymbol(index: number): string | undefined {
    for (const [symbol, idx] of this.assetIndexMap.entries()) {
      if (idx === index) return symbol;
    }
    return undefined;
  }

  getAllSymbols(): string[] {
    return Array.from(this.assetIndexMap.keys());
  }

  isTestnet(): boolean {
    return this.useTestnet;
  }

  getRateLimitStats(): { pending: number; requestsInWindow: number; windowMs: number } {
    return hyperliquidRateLimiter.getStats();
  }

  /**
   * Format price to wire format matching Python SDK's float_to_wire exactly
   * Simply formats to 8 decimal places and normalizes (removes trailing zeros)
   */
  private formatPrice(price: number): string {
    // Handle zero and negative zero (SDK: if rounded == "-0": rounded = "0")
    if (price === 0 || Object.is(price, -0)) return '0';

    // Format to 8 decimal places (SDK: f"{x:.8f}")
    let str = price.toFixed(8);

    // Handle "-0.00000000" case
    if (str === '-0.00000000') return '0';

    // Remove trailing zeros after decimal (matching Decimal.normalize())
    if (str.includes('.')) {
      str = str.replace(/\.?0+$/, '');
    }

    return str;
  }

  /**
   * Format size to wire format matching Python SDK's float_to_wire exactly
   * Simply formats to 8 decimal places and normalizes (removes trailing zeros)
   */
  private formatSize(size: number): string {
    // Handle zero and negative zero
    if (size === 0 || Object.is(size, -0)) return '0';

    // Format to 8 decimal places (SDK: f"{x:.8f}")
    let str = size.toFixed(8);

    // Handle "-0.00000000" case
    if (str === '-0.00000000') return '0';

    // Remove trailing zeros after decimal (matching Decimal.normalize())
    if (str.includes('.')) {
      str = str.replace(/\.?0+$/, '');
    }

    return str;
  }
}
