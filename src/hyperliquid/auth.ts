import { ethers } from 'ethers';

export class HyperliquidAuth {
  private wallet: ethers.Wallet;

  constructor(privateKey: string) {
    this.wallet = new ethers.Wallet(privateKey);
  }

  get address(): string {
    return this.wallet.address;
  }

  async signL1Action(
    action: Record<string, unknown>,
    nonce: number,
    vaultAddress: string | null = null
  ): Promise<{ r: string; s: string; v: number }> {
    const connectionId = this.hashAction(action, vaultAddress, nonce);
    const signature = await this.wallet.signMessage(ethers.utils.arrayify(connectionId));
    const { r, s, v } = ethers.utils.splitSignature(signature);
    return { r, s, v: v! };
  }

  private hashAction(
    action: Record<string, unknown>,
    vaultAddress: string | null,
    nonce: number
  ): Uint8Array {
    const msgPackAction = this.encodeAction(action);

    const data = vaultAddress
      ? ethers.utils.concat([
          msgPackAction,
          ethers.utils.zeroPad(ethers.utils.hexlify(nonce), 8),
          ethers.utils.arrayify(vaultAddress),
        ])
      : ethers.utils.concat([
          msgPackAction,
          ethers.utils.zeroPad(ethers.utils.hexlify(nonce), 8),
        ]);

    return ethers.utils.arrayify(ethers.utils.keccak256(data));
  }

  private encodeAction(action: Record<string, unknown>): Uint8Array {
    // Simple msgpack-like encoding for Hyperliquid
    // In production, you might want to use a proper msgpack library
    const jsonStr = JSON.stringify(action);
    return ethers.utils.toUtf8Bytes(jsonStr);
  }

  async signTypedData(domain: ethers.TypedDataDomain, types: Record<string, ethers.TypedDataField[]>, value: Record<string, unknown>): Promise<string> {
    // For EIP-712 typed data signing if needed
    const signature = await this.wallet._signTypedData(domain, types, value);
    return signature;
  }
}
