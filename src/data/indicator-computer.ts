import { Candle, Timeframe } from '../types';

// Helper functions
function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function mean(arr: number[]): number {
  return arr.length > 0 ? sum(arr) / arr.length : 0;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = sum(arr.map((x) => Math.pow(x - m, 2))) / (arr.length - 1);
  return Math.sqrt(variance);
}

export class IndicatorComputer {
  // ===== MOVING AVERAGES =====

  static sma(values: number[], period: number): number {
    if (values.length < period) return 0;
    return mean(values.slice(-period));
  }

  static ema(values: number[], period: number): number {
    if (values.length < period) return 0;

    const multiplier = 2 / (period + 1);
    let ema = this.sma(values.slice(0, period), period);

    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  static emaFromCandles(candles: Candle[], period: number): number {
    const closes = candles.map((c) => c.close).reverse();
    return this.ema(closes, period);
  }

  // ===== VOLATILITY =====

  static atr(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) return 0;

    const trs: number[] = [];
    const sortedCandles = [...candles].reverse();

    for (let i = 1; i < sortedCandles.length; i++) {
      const current = sortedCandles[i];
      const previous = sortedCandles[i - 1];
      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      );
      trs.push(tr);
    }

    return this.ema(trs, period);
  }

  static bollingerBands(
    candles: Candle[],
    period: number = 20,
    stdDev: number = 2
  ): { upper: number; middle: number; lower: number } {
    const closes = candles.map((c) => c.close).reverse();
    if (closes.length < period) {
      return { upper: 0, middle: 0, lower: 0 };
    }

    const recentCloses = closes.slice(-period);
    const middle = mean(recentCloses);
    const stdDeviation = std(recentCloses);

    return {
      upper: middle + stdDev * stdDeviation,
      middle,
      lower: middle - stdDev * stdDeviation,
    };
  }

  // ===== MOMENTUM =====

  static rsi(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) return 50;

    const closes = candles.map((c) => c.close).reverse();
    const gains: number[] = [];
    const losses: number[] = [];

    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? Math.abs(change) : 0);
    }

    const avgGain = this.ema(gains, period);
    const avgLoss = this.ema(losses, period);

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  static macd(
    candles: Candle[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
  ): { macd: number; signal: number; histogram: number } {
    const closes = candles.map((c) => c.close).reverse();

    if (closes.length < slowPeriod) {
      return { macd: 0, signal: 0, histogram: 0 };
    }

    const fastEma = this.ema(closes, fastPeriod);
    const slowEma = this.ema(closes, slowPeriod);
    const macdLine = fastEma - slowEma;

    // Calculate MACD values for signal line
    const macdValues: number[] = [];
    for (let i = slowPeriod - 1; i < closes.length; i++) {
      const fastEmaPoint = this.ema(closes.slice(0, i + 1), fastPeriod);
      const slowEmaPoint = this.ema(closes.slice(0, i + 1), slowPeriod);
      macdValues.push(fastEmaPoint - slowEmaPoint);
    }

    const signalLine = this.ema(macdValues, signalPeriod);
    const histogram = macdLine - signalLine;

    return { macd: macdLine, signal: signalLine, histogram };
  }

  // ===== TREND =====

  static adx(candles: Candle[], period: number = 14): number {
    if (candles.length < period * 2) return 0;

    const sortedCandles = [...candles].reverse();
    const plusDMs: number[] = [];
    const minusDMs: number[] = [];
    const trs: number[] = [];

    for (let i = 1; i < sortedCandles.length; i++) {
      const current = sortedCandles[i];
      const previous = sortedCandles[i - 1];

      const plusDM = current.high - previous.high;
      const minusDM = previous.low - current.low;

      plusDMs.push(plusDM > 0 && plusDM > minusDM ? plusDM : 0);
      minusDMs.push(minusDM > 0 && minusDM > plusDM ? minusDM : 0);

      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      );
      trs.push(tr);
    }

    const atr = this.ema(trs, period);
    const plusDI = atr !== 0 ? (this.ema(plusDMs, period) / atr) * 100 : 0;
    const minusDI = atr !== 0 ? (this.ema(minusDMs, period) / atr) * 100 : 0;

    const dx = plusDI + minusDI !== 0 ? (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100 : 0;

    // Calculate ADX as EMA of DX values
    const dxValues: number[] = [];
    for (let i = period; i < sortedCandles.length; i++) {
      const slicedCandles = sortedCandles.slice(0, i + 1);
      const slicedPlusDMs = plusDMs.slice(0, i);
      const slicedMinusDMs = minusDMs.slice(0, i);
      const slicedTRs = trs.slice(0, i);

      const slicedAtr = this.ema(slicedTRs, period);
      const slicedPlusDI = slicedAtr !== 0 ? (this.ema(slicedPlusDMs, period) / slicedAtr) * 100 : 0;
      const slicedMinusDI = slicedAtr !== 0 ? (this.ema(slicedMinusDMs, period) / slicedAtr) * 100 : 0;
      const slicedDx = slicedPlusDI + slicedMinusDI !== 0 ? (Math.abs(slicedPlusDI - slicedMinusDI) / (slicedPlusDI + slicedMinusDI)) * 100 : 0;
      dxValues.push(slicedDx);
    }

    return this.ema(dxValues, period);
  }

  // ===== VOLUME =====

  static volumeMA(candles: Candle[], period: number = 20): number {
    const volumes = candles.map((c) => c.volume).reverse();
    return this.sma(volumes, period);
  }

  static volumeRatio(candles: Candle[], period: number = 20): number {
    if (candles.length < period + 1) return 1;

    const currentVolume = candles[0].volume;
    const avgVolume = this.volumeMA(candles.slice(1), period);

    return avgVolume !== 0 ? currentVolume / avgVolume : 1;
  }

  // ===== PRICE ANALYSIS =====

  static priceRange(candles: Candle[], period: number = 24): { high: number; low: number; range: number; rangePct: number } {
    if (candles.length < period) {
      return { high: 0, low: 0, range: 0, rangePct: 0 };
    }

    const recentCandles = candles.slice(0, period);
    const high = Math.max(...recentCandles.map((c) => c.high));
    const low = Math.min(...recentCandles.map((c) => c.low));
    const range = high - low;
    const rangePct = low !== 0 ? (range / low) * 100 : 0;

    return { high, low, range, rangePct };
  }

  static isBreakout(candles: Candle[], period: number = 24): { isUpBreakout: boolean; isDownBreakout: boolean } {
    if (candles.length < period + 1) {
      return { isUpBreakout: false, isDownBreakout: false };
    }

    const currentClose = candles[0].close;
    const { high, low } = this.priceRange(candles.slice(1), period);

    return {
      isUpBreakout: currentClose > high,
      isDownBreakout: currentClose < low,
    };
  }

  // ===== TREND DETECTION =====

  static detectTrend(candles: Candle[]): 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN' {
    if (candles.length < 50) return 'NEUTRAL';

    const ema20 = this.emaFromCandles(candles, 20);
    const ema50 = this.emaFromCandles(candles, 50);
    const currentPrice = candles[0].close;
    const adx = this.adx(candles);

    const priceDiff = ((currentPrice - ema20) / ema20) * 100;
    const emaDiff = ((ema20 - ema50) / ema50) * 100;

    if (adx > 25) {
      if (emaDiff > 2 && priceDiff > 1) return 'STRONG_UP';
      if (emaDiff > 0 && priceDiff > 0) return 'UP';
      if (emaDiff < -2 && priceDiff < -1) return 'STRONG_DOWN';
      if (emaDiff < 0 && priceDiff < 0) return 'DOWN';
    }

    return 'NEUTRAL';
  }

  static detectVolatility(candles: Candle[]): 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' {
    if (candles.length < 20) return 'MEDIUM';

    const atr = this.atr(candles, 14);
    const currentPrice = candles[0].close;
    const atrPct = (atr / currentPrice) * 100;

    if (atrPct < 1) return 'LOW';
    if (atrPct < 3) return 'MEDIUM';
    if (atrPct < 6) return 'HIGH';
    return 'EXTREME';
  }

  static detectRegime(candles: Candle[]): 'TRENDING' | 'RANGING' | 'VOLATILE' | 'UNCLEAR' {
    if (candles.length < 50) return 'UNCLEAR';

    const adx = this.adx(candles);
    const volatility = this.detectVolatility(candles);
    const { rangePct } = this.priceRange(candles, 24);

    if (adx > 25 && volatility !== 'EXTREME') return 'TRENDING';
    if (volatility === 'EXTREME' || volatility === 'HIGH') return 'VOLATILE';
    if (adx < 20 && rangePct < 5) return 'RANGING';
    return 'UNCLEAR';
  }

  // ===== RSI DIVERGENCE =====

  static hasRsiDivergence(candles: Candle[], period: number = 14, lookback: number = 10): boolean {
    if (candles.length < lookback + period) return false;

    const rsiValues: number[] = [];
    const priceValues: number[] = [];

    for (let i = 0; i < lookback; i++) {
      const slicedCandles = candles.slice(i);
      rsiValues.push(this.rsi(slicedCandles, period));
      priceValues.push(candles[i].close);
    }

    // Check for bearish divergence (price making higher highs, RSI making lower highs)
    const priceHigherHigh = priceValues[0] > priceValues[lookback - 1];
    const rsiLowerHigh = rsiValues[0] < rsiValues[lookback - 1];
    if (priceHigherHigh && rsiLowerHigh && rsiValues[0] > 70) return true;

    // Check for bullish divergence (price making lower lows, RSI making higher lows)
    const priceLowerLow = priceValues[0] < priceValues[lookback - 1];
    const rsiHigherLow = rsiValues[0] > rsiValues[lookback - 1];
    if (priceLowerLow && rsiHigherLow && rsiValues[0] < 30) return true;

    return false;
  }

  // ===== EMA CROSSOVER =====

  static emaCrossover(
    candles: Candle[],
    fastPeriod: number = 20,
    slowPeriod: number = 50
  ): { isBullishCross: boolean; isBearishCross: boolean } {
    if (candles.length < slowPeriod + 2) {
      return { isBullishCross: false, isBearishCross: false };
    }

    const currentFastEma = this.emaFromCandles(candles, fastPeriod);
    const currentSlowEma = this.emaFromCandles(candles, slowPeriod);
    const prevFastEma = this.emaFromCandles(candles.slice(1), fastPeriod);
    const prevSlowEma = this.emaFromCandles(candles.slice(1), slowPeriod);

    const isBullishCross = prevFastEma <= prevSlowEma && currentFastEma > currentSlowEma;
    const isBearishCross = prevFastEma >= prevSlowEma && currentFastEma < currentSlowEma;

    return { isBullishCross, isBearishCross };
  }
}
