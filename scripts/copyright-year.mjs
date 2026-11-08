// ---------------------------------------------------------------------------
// copyright-year.mjs: which year a page's copyright line may carry today.
//
// Its own module so it can be unit tested: check-site.mjs runs on import.
//
// The check used to demand the wall-clock year exactly, which failed every
// page at midnight on 1 January. The Credit Cards daily job runs ci:check
// before committing, so that one stale digit would have stopped its perk
// flips, New tags, stats and archiving until someone bumped every footer.
// January accepts last year too; by February the footers must be current.
// ---------------------------------------------------------------------------

export function copyrightYearOk(year, now = new Date()) {
  const current = now.getFullYear();
  return year === current || (now.getMonth() === 0 && year === current - 1);
}
