interface MouseButtonEvent {
  button: number;
  preventDefault(): void;
}

interface AuxiliaryClickEvent extends MouseButtonEvent {
  stopPropagation(): void;
}

export function preventMiddleMouseDefault(event: MouseButtonEvent): boolean {
  if (event.button !== 1) return false;
  event.preventDefault();
  return true;
}

export function closeTabOnMiddleClick(
  event: AuxiliaryClickEvent,
  close: () => void,
): boolean {
  if (!preventMiddleMouseDefault(event)) return false;
  event.stopPropagation();
  close();
  return true;
}
