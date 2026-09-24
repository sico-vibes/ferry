export const name = 'scaling';

export async function run(_page, { captureScaling }) {
  await captureScaling(
    ['/', '/s/session_3', '/explore', '/settings'],
    [1024, 1280, 1440, 1920],
    [1, 1.25, 1.5],
  );
}
