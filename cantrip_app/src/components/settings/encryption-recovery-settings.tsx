import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, KeyRound, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getAccountEncryptionProfile } from "@/lib/encryption-api";
import {
  createAnonymousRecoveryArtifactText,
  saveAnonymousRecoveryArtifact,
} from "@/lib/anonymous-recovery-artifact";
import { clientEncryption } from "@/lib/client-encryption";
import { errorMessage } from "@/lib/error-message";

export function AnonymousRecoverySettingsRow({
  error,
  exporting,
  onExport,
}: {
  error: string | null;
  exporting: boolean;
  onExport(): void;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <KeyRound className="size-4 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Anonymous recovery</h2>
            <p className="text-xs text-muted-foreground">
              Save a bearer recovery file for this server&apos;s encrypted data.
              Without it or this installation key, the data cannot be recovered.
            </p>
          </div>
        </div>
        <Button
          disabled={exporting}
          onClick={onExport}
          size="sm"
          type="button"
          variant="outline"
        >
          {exporting ? <Loader2 className="animate-spin" /> : <Download />}
          Save recovery file
        </Button>
      </div>
      {error ? (
        <p className="px-10 pb-3 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function EncryptionRecoverySettings() {
  const profile = useQuery({
    queryFn: getAccountEncryptionProfile,
    queryKey: ["account-encryption-profile"],
    staleTime: 60_000,
  });
  const exportArtifact = useMutation({
    mutationFn: async () => {
      const snapshot = clientEncryption.getSnapshot();
      if (snapshot.status !== "ready" || !snapshot.identity) {
        throw new Error("Private data encryption is not ready.");
      }
      await saveAnonymousRecoveryArtifact(
        await createAnonymousRecoveryArtifactText({
          identity: snapshot.identity,
        }),
      );
    },
  });
  if (
    profile.data?.status !== "initialized" ||
    profile.data.profile.passwordWrappedMasterKey !== null
  ) {
    return null;
  }
  return (
    <AnonymousRecoverySettingsRow
      error={exportArtifact.error ? errorMessage(exportArtifact.error) : null}
      exporting={exportArtifact.isPending}
      onExport={() => exportArtifact.mutate()}
    />
  );
}
