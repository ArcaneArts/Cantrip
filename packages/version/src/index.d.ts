export interface CantripVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly version: string;
  readonly synthetic: boolean;
  readonly commitSha: string | null;
  readonly builtAt: string | null;
  readonly buildId: string | null;
  readonly overlayDigest: string | null;
}

export declare const CANTRIP_VERSION: string;
export declare const cantripVersion: Readonly<CantripVersion>;
export default cantripVersion;
