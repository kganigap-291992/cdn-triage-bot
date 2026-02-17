from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from telemetry_kit.generator import generate_minute_logs
from telemetry_kit.emit.csv import write_raw_minute_csv


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/cdn_logs_6h_80k_stresstest.csv")
    ap.add_argument("--minutes", type=int, default=360)  # 6h
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--density", type=float, default=0.10)
    ap.add_argument("--partners", type=int, default=6)
    ap.add_argument("--pops", type=int, default=20)
    ap.add_argument("--hosts", type=int, default=120)
    args = ap.parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc)
    start = (now - timedelta(minutes=args.minutes)).replace(second=0, microsecond=0)

    df = generate_minute_logs(
        start_ts_utc=start,
        minutes=args.minutes,
        n_partners=args.partners,
        n_pops=args.pops,
        n_hosts=args.hosts,
        seed=args.seed,
        density=args.density,
        incidents=[],
    )

    out = write_raw_minute_csv(df, out_path)
    print(f"Wrote {len(df):,} rows -> {out}")


if __name__ == "__main__":
    main()
