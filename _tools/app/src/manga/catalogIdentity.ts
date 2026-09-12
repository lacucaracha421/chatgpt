import type { CatalogWorkIdentity } from "../library/types";

export function catalogIdentityOf(identity: CatalogWorkIdentity): CatalogWorkIdentity {
  return {
    provider: identity.provider,
    providerWorkId: identity.providerWorkId,
  };
}

export function catalogIdentityKey(identity: CatalogWorkIdentity): string {
  return `${identity.provider}:${identity.providerWorkId}`;
}
