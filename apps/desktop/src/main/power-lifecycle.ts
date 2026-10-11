interface PowerEvents {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
  removeListener(event: 'suspend' | 'resume', listener: () => void): unknown;
}
/** Resume revalidates the existing Core; it never starts a second writer. */
export function attachPowerLifecycle(
  monitor: PowerEvents,
  actions: { suspend: () => void; resume: () => void },
): () => void {
  monitor.on('suspend', actions.suspend);
  monitor.on('resume', actions.resume);
  return () => {
    monitor.removeListener('suspend', actions.suspend);
    monitor.removeListener('resume', actions.resume);
  };
}
