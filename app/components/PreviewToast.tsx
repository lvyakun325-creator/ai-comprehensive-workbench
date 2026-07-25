type PreviewToastProps = {
  message: string;
};

export function PreviewToast({ message }: PreviewToastProps) {
  if (!message) return null;

  return (
    <div className="toast" role="status" aria-live="polite">
      {message}
    </div>
  );
}
