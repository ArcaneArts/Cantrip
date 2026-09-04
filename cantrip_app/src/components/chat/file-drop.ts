export function dataTransferHasFiles(
  dataTransfer: Pick<DataTransfer, "items" | "types">,
): boolean {
  return (
    Array.from(dataTransfer.types).some(
      (type) => type.toLowerCase() === "files",
    ) || Array.from(dataTransfer.items).some((item) => item.kind === "file")
  );
}

export function filesFromDataTransfer(
  dataTransfer: Pick<DataTransfer, "files">,
): File[] {
  return Array.from(dataTransfer.files);
}
