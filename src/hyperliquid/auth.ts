import { ethers } from 'ethers';
import { encode } from '@msgpack/msgpack';

// EIP-712 domain for L1 actions (phantom agent)
const L1_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};

// Type definitions for EIP-712 signing
const AGENT_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

export class HyperliquidAuth {
  private wallet: ethers.Wallet;
  private isTestnet: boolean;

  constructor(privateKey: string, isTestnet: boolean = false) {
    this.wallet = new ethers.Wallet(privateKey);
    this.isTestnet = isTestnet;
  }

  // IMPORTANT: Hyperliquid docs state addresses must be lowercase for signing
  get address(): string {
    return this.wallet.address.toLowerCase();
  }

  async signL1Action(
    action: Record<string, unknown>,
    nonce: number,
    vaultAddress: string | null = null
  ): Promise<{ r: string; s: string; v: number }> {
    // Normalize the action (remove trailing zeros from price/size)
    const normalizedAction = this.normalizeAction(action);

    // Create the action hash using msgpack encoding
    const connectionId = this.hashAction(normalizedAction, vaultAddress, nonce);

    // Create the phantom agent for EIP-712 signing
    const agent = {
      source: this.isTestnet ? 'b' : 'a', // 'a' for mainnet, 'b' for testnet
      connectionId: connectionId,
    };

    // Sign using EIP-712 typed data
    const signature = await this.wallet._signTypedData(L1_DOMAIN, AGENT_TYPES, agent);
    const { r, s, v } = ethers.utils.splitSignature(signature);

    return { r, s, v: v! };
  }

  private normalizeAction(action: Record<string, unknown>): Record<string, unknown> {
    // Deep clone the action
    const normalized = JSON.parse(JSON.stringify(action));

    // Normalize orders if present (price and size strings)
    if (normalized.orders && Array.isArray(normalized.orders)) {
      normalized.orders = normalized.orders.map((order: Record<string, unknown>) => ({
        ...order,
        p: this.floatToWire(order.p as string),
        s: this.floatToWire(order.s as string),
      }));
    }

    // Normalize modifies if present (batch modify orders)
    if (normalized.modifies && Array.isArray(normalized.modifies)) {
      normalized.modifies = normalized.modifies.map((mod: Record<string, unknown>) => {
        if (mod.order && typeof mod.order === 'object') {
          const order = mod.order as Record<string, unknown>;
          return {
            ...mod,
            order: {
              ...order,
              p: this.floatToWire(order.p as string),
              s: this.floatToWire(order.s as string),
            },
          };
        }
        return mod;
      });
    }

    return normalized;
  }

  /**
   * Converts a float string to wire format matching Python SDK's float_to_wire()
   * - Rounds to 8 significant decimals
   * - Removes trailing zeros
   * - Handles "-0" edge case
   */
  private floatToWire(value: string): string {
    if (!value || typeof value !== 'string') return value;

    // Parse to number and back to handle precision
    const num = parseFloat(value);
    if (isNaN(num)) return value;

    // Handle -0 edge case
    if (Object.is(num, -0) || num === 0) {
      return '0';
    }

    // Round to 8 decimal places (matching SDK)
    const rounded = Math.round(num * 1e8) / 1e8;

    // Convert to string and normalize (remove trailing zeros)
    let str = rounded.toString();

    // Handle scientific notation for very small numbers
    if (str.includes('e')) {
      str = rounded.toFixed(8);
    }

    // Remove trailing zeros after decimal point
    if (str.includes('.')) {
      str = str.replace(/\.?0+$/, '');
    }

    return str;
  }

  private hashAction(
    action: Record<string, unknown>,
    vaultAddress: string | null,
    nonce: number
  ): string {
    // Encode action using msgpack
    const msgPackAction = encode(action);

    // Convert nonce to 8-byte big-endian buffer
    const nonceBytes = new Uint8Array(8);
    const view = new DataView(nonceBytes.buffer);
    view.setBigUint64(0, BigInt(nonce), false); // false = big-endian

    // Vault address: 20 bytes if provided, zeros otherwise
    // Per Chainstack example: msgpack || vault (20 bytes) || nonce
    let vaultBytes: Uint8Array;
    if (vaultAddress) {
      // IMPORTANT: Vault address must be lowercase per Hyperliquid docs
      const normalizedVault = vaultAddress.toLowerCase();
      vaultBytes = ethers.utils.arrayify(normalizedVault);
    } else {
      // Zero-filled 20 bytes when no vault
      vaultBytes = new Uint8Array(20);
    }

    // Concatenate: msgpack action + vault address (20 bytes) + nonce (8 bytes)
    const data = new Uint8Array([...msgPackAction, ...vaultBytes, ...nonceBytes]);

    // Return keccak256 hash as bytes32
    return ethers.utils.keccak256(data);
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, unknown>
  ): Promise<string> {
    const signature = await this.wallet._signTypedData(domain, types, value);
    return signature;
  }
}
