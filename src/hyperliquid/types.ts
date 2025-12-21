// Re-export types that are specific to Hyperliquid API
export {
  HyperliquidMeta,
  HyperliquidAccountInfo,
  HyperliquidOpenOrder,
  HyperliquidFill,
  HyperliquidFundingHistory,
  HyperliquidCandle,
  OrderRequest,
  OrderResponse,
} from '../types';

// Additional Hyperliquid-specific types
export interface L2Book {
  coin: string;
  levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>];
  time: number;
}

export interface TradeData {
  coin: string;
  side: string;
  px: string;
  sz: string;
  time: number;
  hash: string;
}

export interface UserEvent {
  fills?: HyperliquidFill[];
  funding?: {
    time: number;
    coin: string;
    usdc: string;
    szi: string;
    fundingRate: string;
  };
  liquidation?: {
    liq_id: number;
    coin: string;
    szi: string;
    leverage: number;
  };
}

export interface CancelRequest {
  asset: number;
  oid: number;
}

export interface CancelResponse {
  status: 'ok' | 'error';
  response?: {
    type: string;
    data: {
      statuses: string[];
    };
  };
}

// Asset context from metaAndAssetCtxs endpoint
export interface AssetContext {
  coin: string;
  dayNtlVlm: string;      // Daily notional volume
  funding: string;        // Current funding rate
  impactPxs: [string, string]; // Impact bid/ask prices
  markPx: string;         // Mark price
  midPx: string;          // Mid price
  openInterest: string;   // Open interest in contracts
  oraclePx: string;       // Oracle price
  premium: string;        // Premium/basis
  prevDayPx: string;      // Previous day price
}

// Response from metaAndAssetCtxs endpoint
export interface MetaAndAssetCtxsResponse {
  meta: HyperliquidMeta;
  assetCtxs: AssetContext[];
}

import { HyperliquidFill, HyperliquidMeta } from '../types';
