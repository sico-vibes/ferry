export function SmartTip({ children }: { children: string }) {
  return (
    <p
      tabIndex={0}
      className="smart-tip mx-auto mt-4 max-w-xl text-xs leading-5 text-muted-foreground"
    >
      {children}
    </p>
  );
}
