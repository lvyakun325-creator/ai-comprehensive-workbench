type PreviewToastProps = {
  message: string;
};

export function PreviewToast({ message }: PreviewToastProps) {
  if (!message) return null;

  return (
    <div
      className="toast"
      role="status"
      aria-label="设计预览提示"
      aria-live="polite"
    >
      {message}
    </div>
  );
}
