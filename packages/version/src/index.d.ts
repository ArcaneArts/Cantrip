export interface CantripVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly version: string;
}

export declare const CANTRIP_VERSION: string;
export declare const cantripVersion: Readonly<CantripVersion>;
export default cantripVersion;
