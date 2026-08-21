import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import { cn } from "@/lib/utils";

export interface ReviewedOperationContext<TRequest, TPreview> {
  preview: TPreview;
  request: TRequest;
}

export interface ReviewedOperationController<TRequest, TPreview, TResult> {
  apply: UseMutationResult<TResult, Error, void>;
  applyReviewed(): void;
  busy: boolean;
  canApply: boolean;
  onOpenChange(open: boolean): void;
  open: boolean;
  preview: UseMutationResult<TPreview, Error, TRequest>;
  previewMatchesRequest: boolean;
  request: TRequest | null;
  reset(): void;
  review(request: TRequest): void;
  updateRequest(request: TRequest): void;
}

export function reviewedOperationAvailability(
  hasRequest: boolean,
  hasPreview: boolean,
  previewMatchesRequest: boolean,
  applyPending: boolean,
) {
  return {
    canApply:
      hasRequest && hasPreview && previewMatchesRequest && !applyPending,
    open: hasRequest,
  };
}

export function requireReviewedOperationContext<TRequest, TPreview>(
  request: TRequest | null,
  previewRequest: TRequest | null,
  preview: TPreview | null,
  requestsEqual: (left: TRequest, right: TRequest) => boolean,
  missingReviewMessage: string,
  staleReviewMessage: string,
): ReviewedOperationContext<TRequest, TPreview> {
  if (request === null || previewRequest === null || preview === null) {
    throw new Error(missingReviewMessage);
  }
  if (!requestsEqual(request, previewRequest)) {
    throw new Error(staleReviewMessage);
  }
  return { preview, request };
}

export function useReviewedOperation<TRequest, TPreview, TResult>({
  apply: applyOperation,
  missingReviewMessage = "Review this operation first.",
  onSuccess,
  preview: previewOperation,
  requestsEqual = Object.is,
  resolveReviewedRequest,
  staleReviewMessage = "The operation changed after review. Review it again before applying.",
}: {
  apply(
    context: ReviewedOperationContext<TRequest, TPreview>,
  ): Promise<TResult>;
  missingReviewMessage?: string;
  onSuccess?(
    result: TResult,
    context: ReviewedOperationContext<TRequest, TPreview>,
  ): void;
  preview(request: TRequest): Promise<TPreview>;
  requestsEqual?(left: TRequest, right: TRequest): boolean;
  resolveReviewedRequest?(request: TRequest, preview: TPreview): TRequest;
  staleReviewMessage?: string;
}): ReviewedOperationController<TRequest, TPreview, TResult> {
  const [request, setRequest] = useState<TRequest | null>(null);
  const requestRef = useRef<TRequest | null>(null);
  const previewRequestRef = useRef<TRequest | null>(null);
  const previewRef = useRef<TPreview | null>(null);

  const clearReview = useCallback(() => {
    requestRef.current = null;
    previewRequestRef.current = null;
    previewRef.current = null;
    setRequest(null);
  }, []);

  const preview = useMutation<TPreview, Error, TRequest>({
    mutationFn: previewOperation,
    onSuccess: (result, requested) => {
      if (
        requestRef.current === null ||
        !requestsEqual(requestRef.current, requested)
      ) {
        return;
      }
      const reviewed = resolveReviewedRequest?.(requested, result) ?? requested;
      requestRef.current = reviewed;
      previewRequestRef.current = reviewed;
      previewRef.current = result;
      setRequest(reviewed);
    },
  });
  const apply = useMutation<TResult, Error, void>({
    mutationFn: () => {
      const context = requireReviewedOperationContext(
        requestRef.current,
        previewRequestRef.current,
        previewRef.current,
        requestsEqual,
        missingReviewMessage,
        staleReviewMessage,
      );
      return applyOperation(context);
    },
    onSuccess: (result) => {
      const reviewedRequest = requestRef.current;
      const reviewedPreview = previewRef.current;
      if (reviewedRequest !== null && reviewedPreview !== null) {
        onSuccess?.(result, {
          preview: reviewedPreview,
          request: reviewedRequest,
        });
      }
      clearReview();
      preview.reset();
    },
  });

  const reset = useCallback(() => {
    if (apply.isPending) return;
    clearReview();
    preview.reset();
    apply.reset();
  }, [apply, clearReview, preview]);
  const review = useCallback(
    (nextRequest: TRequest) => {
      if (preview.isPending || apply.isPending) return;
      requestRef.current = nextRequest;
      previewRequestRef.current = null;
      previewRef.current = null;
      setRequest(nextRequest);
      preview.reset();
      apply.reset();
      preview.mutate(nextRequest);
    },
    [apply, preview],
  );
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) reset();
    },
    [reset],
  );

  const availability = reviewedOperationAvailability(
    request !== null,
    preview.data !== undefined,
    request !== null &&
      previewRequestRef.current !== null &&
      requestsEqual(request, previewRequestRef.current),
    apply.isPending,
  );
  return {
    apply,
    applyReviewed: () => apply.mutate(),
    busy: preview.isPending || apply.isPending,
    canApply: availability.canApply,
    onOpenChange,
    open: availability.open,
    preview,
    previewMatchesRequest:
      request !== null &&
      previewRequestRef.current !== null &&
      requestsEqual(request, previewRequestRef.current),
    request,
    reset,
    review,
    updateRequest: (nextRequest) => {
      if (preview.isPending || apply.isPending) return;
      requestRef.current = nextRequest;
      setRequest(nextRequest);
      apply.reset();
    },
  };
}

function operationError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ReviewedOperationDialog<TRequest, TPreview, TResult>({
  applyClassName,
  applyDisabled = false,
  applyLabel,
  applyVariant,
  bodyClassName,
  children,
  contentClassName,
  description,
  errorClassName,
  footerClassName,
  loadingClassName,
  loadingLabel,
  operation,
  previewErrorFallback,
  applyErrorFallback,
  title,
}: {
  applyClassName?: string;
  applyDisabled?: boolean;
  applyErrorFallback: string;
  applyLabel: ReactNode;
  applyVariant?: "default" | "destructive";
  bodyClassName?: string;
  children(preview: TPreview, request: TRequest): ReactNode;
  contentClassName?: string;
  description: ReactNode;
  errorClassName?: string;
  footerClassName?: string;
  loadingClassName?: string;
  loadingLabel: ReactNode;
  operation: ReviewedOperationController<TRequest, TPreview, TResult>;
  previewErrorFallback: string;
  title: ReactNode;
}) {
  return (
    <Dialog open={operation.open} onOpenChange={operation.onOpenChange}>
      <DialogContent className={contentClassName}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className={bodyClassName}>
          {operation.preview.isPending ? (
            <div
              className={cn(
                "flex items-center justify-center gap-2 text-muted-foreground",
                loadingClassName,
              )}
            >
              <Loader2 className="size-4 animate-spin" /> {loadingLabel}
            </div>
          ) : operation.preview.error ? (
            <InlineAlert className={errorClassName} tone="error">
              {operationError(operation.preview.error, previewErrorFallback)}
            </InlineAlert>
          ) : operation.preview.data !== undefined &&
            operation.request !== null ? (
            children(operation.preview.data, operation.request)
          ) : null}
          {operation.apply.error ? (
            <InlineAlert className={errorClassName} tone="error">
              {operationError(operation.apply.error, applyErrorFallback)}
            </InlineAlert>
          ) : null}
        </div>
        <DialogFooter className={footerClassName}>
          <Button
            variant="outline"
            disabled={operation.apply.isPending}
            onClick={operation.reset}
          >
            Cancel
          </Button>
          <Button
            className={applyClassName}
            disabled={!operation.canApply || applyDisabled}
            onClick={operation.applyReviewed}
            pending={operation.apply.isPending}
            pendingLabel={applyLabel}
            variant={applyVariant}
          >
            {applyLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
