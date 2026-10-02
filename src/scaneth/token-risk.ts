/**
 * Token executability screening via honeypot.is (on-chain buy/sell
 * simulation). Supplies the live-capital realism layer: buy/sell taxes and
 * honeypot detection for paper fills.
 *
 * Fail-open policy: when the API is unreachable or the simulation does not
 * succeed (common for Uniswap V3 pools), risk is reported as unknown and the
 * caller proceeds — over-blocking on simulation gaps would filter legitimate
 * trades. Confirmed honeypots always block.
 */
import { createLogger, errMeta } from '../logger';

const log = createLogger('scaneth:token-risk');

export interface TokenRisk {
  /** Simulation succeeded — tax numbers are real, not defaults. */
  ok: boolean;
  /** Confirmed honeypot: buys are traps, exits are impossible. */
  honeypot: boolean;
  buyTaxPct: number;
  sellTaxPct: number;
  checkedAt: number;
}

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, TokenRisk>();

function clampTaxPct(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(95, n);
}

/** Screen a token (cached 10 min). Never throws; unknown -> ok=false. */
export async function getTokenRisk(token: string, chainId = 1): Promise<TokenRisk> {
  const key = `${chainId}:${token.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.checkedAt < CACHE_TTL_MS) return hit;

  const failOpen: TokenRisk = {
    ok: false,
    honeypot: false,
    buyTaxPct: 0,
    sellTaxPct: 0,
    checkedAt: Date.now(),
  };

  try {
    const res = await fetch(
      `https://api.honeypot.is/v2/IsHoneypot?address=${token}&chainID=${chainId}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) {
      log.debug('token-risk fetch failed', { token, status: res.status });
      cache.set(key, failOpen);
      return failOpen;
    }
    const j = (await res.json()) as {
      simulationSuccess?: boolean;
      honeypotResult?: { isHoneypot?: boolean };
      simulationResult?: { buyTax?: number; sellTax?: number };
    };
    const simOk = Boolean(j.simulationSuccess);
    const risk: TokenRisk = {
      ok: simOk,
      honeypot: Boolean(j.honeypotResult?.isHoneypot),
      buyTaxPct: simOk ? clampTaxPct(j.simulationResult?.buyTax) : 0,
      sellTaxPct: simOk ? clampTaxPct(j.simulationResult?.sellTax) : 0,
      checkedAt: Date.now(),
    };
    cache.set(key, risk);
    log.info('token-risk screened', {
      token,
      ok: risk.ok,
      honeypot: risk.honeypot,
      buyTaxPct: risk.buyTaxPct,
      sellTaxPct: risk.sellTaxPct,
    });
    return risk;
  } catch (err) {
    log.debug('token-risk fetch error', { token, ...errMeta(err) });
    cache.set(key, failOpen);
    return failOpen;
  }
}
