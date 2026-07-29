export function extensionDialogOwner(dialog: { extensionRequestId?: number } | undefined): number | undefined {
    return dialog?.extensionRequestId;
}
