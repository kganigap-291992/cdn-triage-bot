    // ui/lib/chat/explorationAgent.ts

    import type {
    ExplorationAtsMode,
    ExplorationBreakdownRow,
    ExplorationIntent,
    ExplorationMetric,
    ExplorationResult,
    ExplorationView,
    } from "./explorationTypes";
    import type { AtsOperationalFamily } from "@/lib/triage/atsCrcGlossary";

    export type ExplorationAgentContext = {
    partner: string;
    service: string;
    region: string;
    pop: string;
    contentType: string;
    uaFamily: string;
    windowMinutes: number;
    startTsUtc?: string | null;
    endTsUtc?: string | null;
    };

    type TriageTimeseriesPoint = {
    ts: string;
    totalRequests?: number | null;
    errorRatePct?: number | null;
    error5xxCount?: number | null;
    p95TtmsMs?: number | null;
    p99TtmsMs?: number | null;
    cacheHitRate?: number | null;
    };

    type AtsSummary = {
    hitCount: number;
    missCount: number;
    refreshCount: number;
    clientErrorCount: number;
    infraErrorCount: number;
    atsTotal: number;
    hitPct: number;
    missPct: number;
    refreshPct: number;
    clientErrorPct: number;
    infraErrorPct: number;
    };

    type AtsSummaryTimeseriesPoint = {
    ts: string;
    hitCount: number;
    missCount: number;
    refreshCount: number;
    clientErrorCount: number;
    infraErrorCount: number;
    atsTotal: number;
    hitPct: number;
    missPct: number;
    refreshPct: number;
    clientErrorPct: number;
    infraErrorPct: number;
    };

    type AtsBreakdownRowRaw = {
    region?: string;
    pop?: string;
    contentType?: string;
    content_type?: string;
    uaFamily?: string;
    ua_family?: string;
    totalRequests?: number | null;
    hitCount?: number | null;
    hit_count?: number | null;
    missCount?: number | null;
    miss_count?: number | null;
    refreshCount?: number | null;
    refresh_count?: number | null;
    clientErrorCount?: number | null;
    client_error_count?: number | null;
    infraErrorCount?: number | null;
    infra_error_count?: number | null;
    };

    type TriageResponseShape = {
    ok?: boolean;
    error?: string;
    metricsJson?: {
        timeseries?: {
        points?: TriageTimeseriesPoint[];
        bucketSeconds?: number | null;
        startTs?: string | null;
        endTs?: string | null;
        };
        atsSummary?: unknown;
        previousAtsSummary?: unknown;
        atsSummaryTimeseries?: unknown[];
        previousAtsSummaryTimeseries?: unknown[];
        atsByRegion?: AtsBreakdownRowRaw[];
        atsByPop?: AtsBreakdownRowRaw[];
        atsByContentType?: AtsBreakdownRowRaw[];
        atsByUaFamily?: AtsBreakdownRowRaw[];
    };
    sql?: {
        queries?: string[];
        params?: Record<string, any>;
    } | null;
    };

    function buildScopeLabel(context: ExplorationAgentContext): string {
    const scopeBits = [
        context.partner,
        context.service,
        context.region !== "all" ? context.region : null,
        context.pop !== "all" ? context.pop : null,
        context.contentType !== "all" ? context.contentType : null,
        context.uaFamily !== "all" ? context.uaFamily : null,
    ].filter(Boolean);

    return scopeBits.join(" • ");
    }

    function humanizeView(view: ExplorationView): string {
    return view.replace("by_", "by ");
    }

    function titleFor(metric: ExplorationMetric, view: ExplorationView): string {
    if (view === "over_time") return `${metric} over time`;
    return `${metric} ${humanizeView(view)}`;
    }

    function humanizeDimensionValue(key: string): string {
    return String(key || "").replace(/_/g, " ");
    }

    function numOrNull(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
    }

    function numOrZero(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
    }

    function cleanNumber(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
    }

    function cleanTs(value: unknown): string {
    return typeof value === "string" ? value : "";
    }

    function toSeriesPoint(ts: string, value: number | null) {
    return { ts, value };
    }

    function normalizeBreakdownKey(value: unknown): string | null {
    const s = String(value ?? "").trim().toLowerCase();
    return s || null;
    }

    function isAtsCompareQuery(text: string): boolean {
    const t = text.toLowerCase();
    return (
        t.includes("what changed") ||
        t.includes("compare") ||
        t.includes(" vs ") ||
        t.includes("previous") ||
        t.includes("previous window") ||
        t.includes("what increased") ||
        t.includes("what decreased")
    );
    }

    function getAtsFamilyField(
    family?: AtsOperationalFamily | null
    ):
    | "hitPct"
    | "missPct"
    | "refreshPct"
    | "clientErrorPct"
    | "infraErrorPct" {
    switch (family) {
        case "miss":
        return "missPct";
        case "refresh":
        return "refreshPct";
        case "client_err":
        return "clientErrorPct";
        case "infra_err":
        return "infraErrorPct";
        case "hit":
        default:
        return "hitPct";
    }
    }

    function getAtsFamilyLabel(family?: AtsOperationalFamily | null): string {
    switch (family) {
        case "miss":
        return "Miss %";
        case "refresh":
        return "Refresh %";
        case "client_err":
        return "Client Error %";
        case "infra_err":
        return "Infra Error %";
        case "hit":
        default:
        return "Hit %";
    }
    }

    function getAtsFamilySummaryLabel(family?: AtsOperationalFamily | null): string {
    switch (family) {
        case "miss":
        return "miss";
        case "refresh":
        return "refresh";
        case "client_err":
        return "client error";
        case "infra_err":
        return "infra error";
        case "hit":
        default:
        return "hit";
    }
    }

    function buildSummaryForOverTime(args: {
    metric: ExplorationMetric;
    scopeLabel: string;
    pointCount: number;
    startTs?: string | null;
    endTs?: string | null;
    latestValue?: number | null;
    latestP95?: number | null;
    latestP99?: number | null;
    }): string {
    const rangeText =
        args.startTs && args.endTs
        ? `${args.startTs} → ${args.endTs}`
        : "active investigation window";

    if (args.metric === "latency") {
        return [
        `Showing latency trend for ${args.scopeLabel}.`,
        `Window: ${rangeText}.`,
        `Points: ${args.pointCount}.`,
        `Latest p95: ${
            args.latestP95 == null ? "n/a" : `${Math.round(args.latestP95)} ms`
        } • Latest p99: ${
            args.latestP99 == null ? "n/a" : `${Math.round(args.latestP99)} ms`
        }.`,
        ].join(" ");
    }

    if (args.metric === "errors") {
        return [
        `Showing errors trend for ${args.scopeLabel}.`,
        `Window: ${rangeText}.`,
        `Points: ${args.pointCount}.`,
        `Latest error rate: ${
            args.latestValue == null ? "n/a" : `${args.latestValue.toFixed(2)}%`
        }.`,
        ].join(" ");
    }

    if (args.metric === "requests") {
        return [
        `Showing requests trend for ${args.scopeLabel}.`,
        `Window: ${rangeText}.`,
        `Points: ${args.pointCount}.`,
        `Latest requests: ${
            args.latestValue == null
            ? "n/a"
            : Math.round(args.latestValue).toLocaleString()
        }.`,
        ].join(" ");
    }

    return `Showing ${args.metric} trend for ${args.scopeLabel}.`;
    }

    function summaryFor(args: {
    metric: ExplorationMetric;
    view: ExplorationView;
    scopeLabel: string;
    atsMode?: ExplorationAtsMode;
    }): string {
    if (args.metric === "ats") {
        const atsLabel = args.atsMode === "detailed" ? "ATS detailed" : "ATS";
        if (args.view === "over_time") {
        return `Showing ${atsLabel} trend for ${args.scopeLabel}.`;
        }
        return `Showing ${atsLabel} breakdown for ${args.scopeLabel}.`;
    }

    if (args.view === "over_time") {
        return `Showing ${args.metric} trend for ${args.scopeLabel}.`;
    }

    return `Showing ${args.metric} breakdown for ${args.scopeLabel}.`;
    }

    function breakdownKeysForView(view: ExplorationView): string[] {
    switch (view) {
        case "by_region":
        return ["us-east", "us-west", "us-central", "eu-west", "eu-central", "ap-south"];
        case "by_pop":
        return ["pop_003", "pop_007", "pop_011", "pop_014", "pop_017", "pop_020"];
        case "by_ua":
        return ["mobile", "web", "stb", "smart_tv", "console"];
        case "by_content":
        return ["manifest", "segment", "api"];
        case "over_time":
        default:
        return [];
    }
    }

    function buildBreakdownRows(args: {
    metric: ExplorationMetric;
    view: Exclude<ExplorationView, "over_time">;
    atsMode?: ExplorationAtsMode;
    }): ExplorationBreakdownRow[] {
    const keys = breakdownKeysForView(args.view);

    if (args.metric === "latency") {
        return keys.map((key, idx) => ({
        key,
        value: Math.round((180 + idx * 28 + (idx % 2 === 0 ? 24 : 8)) * 100) / 100,
        secondaryValue: Math.round((260 + idx * 32 + (idx % 3) * 14) * 100) / 100,
        tertiaryValue: Math.round((9000 + idx * 2200 + (idx % 2) * 700) * 100) / 100,
        }));
    }

    if (args.metric === "requests") {
        return keys.map((key, idx) => ({
        key,
        value: Math.round((22000 - idx * 2300 + (idx % 2) * 900) * 100) / 100,
        secondaryValue: Math.round((0.18 + idx * 0.07) * 100) / 100,
        tertiaryValue: Math.round((190 + idx * 22) * 100) / 100,
        }));
    }

    if (args.metric === "errors") {
        return keys.map((key, idx) => ({
        key,
        value: Math.round((0.32 + idx * 0.19 + (idx % 2) * 0.08) * 100) / 100,
        secondaryValue: Math.round((180 + idx * 26) * 100) / 100,
        tertiaryValue: Math.round((16000 - idx * 1700) * 100) / 100,
        }));
    }

    const atsMode = args.atsMode ?? "category";

    if (atsMode === "detailed") {
        return keys.map((key, idx) => ({
        key,
        value: Math.round((68 - idx * 4.5) * 100) / 100,
        secondaryValue: Math.round((14 + idx * 2.4) * 100) / 100,
        tertiaryValue: Math.round((3 + idx * 0.8) * 100) / 100,
        }));
    }

    return keys.map((key, idx) => ({
        key,
        value: Math.round((82 - idx * 3.2) * 100) / 100,
        secondaryValue: Math.round((10 + idx * 1.7) * 100) / 100,
        tertiaryValue: Math.round((4 + idx * 0.9) * 100) / 100,
    }));
    }

    function pickWorstKey(
    rows: ExplorationBreakdownRow[],
    metric: ExplorationMetric
    ): string | null {
    if (!rows.length) return null;

    if (metric === "latency" || metric === "errors") {
        return rows.reduce((worst, row) => {
        const worstVal = worst.value ?? Number.NEGATIVE_INFINITY;
        const rowVal = row.value ?? Number.NEGATIVE_INFINITY;
        return rowVal > worstVal ? row : worst;
        }).key;
    }

    return null;
    }

    function normalizeAtsSummary(raw: unknown): AtsSummary | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const row = raw as Record<string, unknown>;

    const hitCount = numOrZero(row.hitCount ?? row.hit_count);
    const missCount = numOrZero(row.missCount ?? row.miss_count);
    const refreshCount = numOrZero(row.refreshCount ?? row.refresh_count);
    const clientErrorCount = numOrZero(
        row.clientErrorCount ?? row.client_error_count
    );
    const infraErrorCount = numOrZero(
        row.infraErrorCount ?? row.infra_error_count
    );

    const atsTotal =
        row.atsTotal != null
        ? numOrZero(row.atsTotal)
        : hitCount + missCount + refreshCount + clientErrorCount + infraErrorCount;

    const hitPct =
        numOrNull(row.hitPct ?? row.hit_pct) ??
        (atsTotal > 0 ? (100 * hitCount) / atsTotal : 0);

    const missPct =
        numOrNull(row.missPct ?? row.miss_pct) ??
        (atsTotal > 0 ? (100 * missCount) / atsTotal : 0);

    const refreshPct =
        numOrNull(row.refreshPct ?? row.refresh_pct) ??
        (atsTotal > 0 ? (100 * refreshCount) / atsTotal : 0);

    const clientErrorPct =
        numOrNull(row.clientErrorPct ?? row.client_error_pct) ??
        (atsTotal > 0 ? (100 * clientErrorCount) / atsTotal : 0);

    const infraErrorPct =
        numOrNull(row.infraErrorPct ?? row.infra_error_pct) ??
        (atsTotal > 0 ? (100 * infraErrorCount) / atsTotal : 0);

    return {
        hitCount,
        missCount,
        refreshCount,
        clientErrorCount,
        infraErrorCount,
        atsTotal,
        hitPct,
        missPct,
        refreshPct,
        clientErrorPct,
        infraErrorPct,
    };
    }

    function normalizeAtsSummaryTimeseries(
    rows: unknown
    ): AtsSummaryTimeseriesPoint[] {
    if (!Array.isArray(rows)) return [];

    return rows
        .map((rowRaw) => {
        const row = rowRaw as Record<string, unknown>;
        const ts = cleanTs(row.ts ?? row.bucket);
        if (!ts) return null;

        const hitCount = numOrZero(row.hitCount ?? row.hit_count);
        const missCount = numOrZero(row.missCount ?? row.miss_count);
        const refreshCount = numOrZero(row.refreshCount ?? row.refresh_count);
        const clientErrorCount = numOrZero(
            row.clientErrorCount ?? row.client_error_count
        );
        const infraErrorCount = numOrZero(
            row.infraErrorCount ?? row.infra_error_count
        );

        const atsTotal =
            hitCount + missCount + refreshCount + clientErrorCount + infraErrorCount;

        const hitPct = atsTotal > 0 ? (100 * hitCount) / atsTotal : 0;
        const missPct = atsTotal > 0 ? (100 * missCount) / atsTotal : 0;
        const refreshPct = atsTotal > 0 ? (100 * refreshCount) / atsTotal : 0;
        const clientErrorPct =
            atsTotal > 0 ? (100 * clientErrorCount) / atsTotal : 0;
        const infraErrorPct =
            atsTotal > 0 ? (100 * infraErrorCount) / atsTotal : 0;

        return {
            ts,
            hitCount,
            missCount,
            refreshCount,
            clientErrorCount,
            infraErrorCount,
            atsTotal,
            hitPct,
            missPct,
            refreshPct,
            clientErrorPct,
            infraErrorPct,
        };
        })
        .filter(Boolean) as AtsSummaryTimeseriesPoint[];
    }

    function buildAtsDeltaRows(args: {
    current?: AtsSummary;
    previous?: AtsSummary;
    }): ExplorationBreakdownRow[] {
    const current = args.current;
    const previous = args.previous;

    if (!current || !previous) return [];

    const rows: ExplorationBreakdownRow[] = [
        {
        key: "hit",
        value: Number((current.hitPct - previous.hitPct).toFixed(2)),
        secondaryValue: current.hitPct,
        tertiaryValue: previous.hitPct,
        },
        {
        key: "miss",
        value: Number((current.missPct - previous.missPct).toFixed(2)),
        secondaryValue: current.missPct,
        tertiaryValue: previous.missPct,
        },
        {
        key: "refresh",
        value: Number((current.refreshPct - previous.refreshPct).toFixed(2)),
        secondaryValue: current.refreshPct,
        tertiaryValue: previous.refreshPct,
        },
        {
        key: "client_error",
        value: Number(
            (current.clientErrorPct - previous.clientErrorPct).toFixed(2)
        ),
        secondaryValue: current.clientErrorPct,
        tertiaryValue: previous.clientErrorPct,
        },
        {
        key: "infra_error",
        value: Number(
            (current.infraErrorPct - previous.infraErrorPct).toFixed(2)
        ),
        secondaryValue: current.infraErrorPct,
        tertiaryValue: previous.infraErrorPct,
        },
    ];

    rows.sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
    return rows;
    }

    function buildAtsDriverSummary(args: {
    current?: AtsSummary;
    previous?: AtsSummary;
    scopeLabel: string;
    }): string {
    const { current, previous, scopeLabel } = args;

    if (!current) {
        return `Showing ATS trend for ${scopeLabel}.`;
    }

    if (!previous) {
        return [
        `Showing ATS trend for ${scopeLabel}.`,
        `Current hit ${current.hitPct.toFixed(2)}%, miss ${current.missPct.toFixed(
            2
        )}%, refresh ${current.refreshPct.toFixed(2)}%, client error ${current.clientErrorPct.toFixed(
            2
        )}%, infra error ${current.infraErrorPct.toFixed(2)}%.`,
        ].join(" ");
    }

    const deltaRows = buildAtsDeltaRows({ current, previous });
    const top = deltaRows[0];

    if (!top) {
        return `Showing ATS compare for ${scopeLabel}.`;
    }

    const label = humanizeDimensionValue(top.key);

    if (top.key === "miss" && (top.value ?? 0) > 0) {
        return `Misses increased the most for ${scopeLabel}, which is the main driver of hit-rate decline.`;
    }

    if (top.key === "infra_error" && (top.value ?? 0) > 0) {
        return `Infrastructure cache errors increased the most for ${scopeLabel}.`;
    }

    if (top.key === "client_error" && (top.value ?? 0) > 0) {
        return `Client-side cache delivery errors increased the most for ${scopeLabel}.`;
    }

    if (top.key === "hit" && (top.value ?? 0) < 0) {
        return `Hit rate fell versus the previous window for ${scopeLabel}.`;
    }

    return `${label} changed the most versus the previous window for ${scopeLabel}.`;
    }

    function buildAtsBreakdownRows(
    rows: AtsBreakdownRowRaw[] | undefined,
    view: Exclude<ExplorationView, "over_time">
    ): ExplorationBreakdownRow[] {
    if (!Array.isArray(rows)) return [];

    return rows
        .map((row) => {
        const key =
            view === "by_region"
            ? normalizeBreakdownKey(row.region)
            : view === "by_pop"
            ? normalizeBreakdownKey(row.pop)
            : view === "by_content"
            ? normalizeBreakdownKey(row.contentType ?? row.content_type)
            : normalizeBreakdownKey(row.uaFamily ?? row.ua_family);

        if (!key) return null;

        const hitCount = numOrZero(row.hitCount ?? row.hit_count);
        const missCount = numOrZero(row.missCount ?? row.miss_count);
        const refreshCount = numOrZero(row.refreshCount ?? row.refresh_count);
        const clientErrorCount = numOrZero(
            row.clientErrorCount ?? row.client_error_count
        );
        const infraErrorCount = numOrZero(
            row.infraErrorCount ?? row.infra_error_count
        );

        const atsTotal =
            hitCount + missCount + refreshCount + clientErrorCount + infraErrorCount;

        if (atsTotal === 0) {
            return {
            key,
            value: 0,
            secondaryValue: 0,
            tertiaryValue: 0,
            quaternaryValue: 0,
            };
        }

        const missPct = (100 * missCount) / atsTotal;
        const refreshPct = (100 * refreshCount) / atsTotal;
        const clientErrorPct = (100 * clientErrorCount) / atsTotal;
        const infraErrorPct = (100 * infraErrorCount) / atsTotal;

        return {
            key,
            value: Number(missPct.toFixed(2)),
            secondaryValue: Number(refreshPct.toFixed(2)),
            tertiaryValue: Number(clientErrorPct.toFixed(2)),
            quaternaryValue: Number(infraErrorPct.toFixed(2)),
        };
        })
        .filter(Boolean) as ExplorationBreakdownRow[];
    }

    async function fetchExplorationTriage(
    context: ExplorationAgentContext
    ): Promise<TriageResponseShape> {
    const payload: Record<string, any> = {
        dataSource: "clickhouse",
        partner: context.partner,
        service: context.service,
        region: context.region,
        pop: context.pop,
        contentType: context.contentType,
        uaFamily: context.uaFamily,
        windowMinutes: context.windowMinutes,
        debug: false,
    };

    if (context.startTsUtc && context.endTsUtc) {
        payload.startTsUtc = context.startTsUtc;
        payload.endTsUtc = context.endTsUtc;
    }

    const resp = await fetch("/api/triage", {
        method: "POST",
        headers: {
        "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    const json = (await resp.json().catch(() => null)) as TriageResponseShape | null;

    if (!resp.ok) {
        throw new Error(
        json?.error || `Exploration request failed (HTTP ${resp.status})`
        );
    }

    if (!json?.ok) {
        throw new Error(json?.error || "Exploration request returned ok=false");
    }

    return json;
    }

    async function buildRealOverTimeResult(args: {
    metric: ExplorationMetric;
    context: ExplorationAgentContext;
    }): Promise<ExplorationResult> {
    const { metric, context } = args;
    const scopeLabel = buildScopeLabel(context);
    const triage = await fetchExplorationTriage(context);

    const points = Array.isArray(triage.metricsJson?.timeseries?.points)
        ? triage.metricsJson?.timeseries?.points ?? []
        : [];

    const startTs =
        triage.metricsJson?.timeseries?.startTs ?? context.startTsUtc ?? null;
    const endTs =
        triage.metricsJson?.timeseries?.endTs ?? context.endTsUtc ?? null;

    if (metric === "latency") {
        const p95Series = points
        .map((point) => {
            const ts = cleanTs(point.ts);
            const value = cleanNumber(point.p95TtmsMs);
            return ts ? toSeriesPoint(ts, value) : null;
        })
        .filter(Boolean) as Array<{ ts: string; value: number | null }>;

        const p99Series = points
        .map((point) => {
            const ts = cleanTs(point.ts);
            const value = cleanNumber(point.p99TtmsMs);
            return ts ? toSeriesPoint(ts, value) : null;
        })
        .filter(Boolean) as Array<{ ts: string; value: number | null }>;

        const latest = points.length ? points[points.length - 1] : null;
        const latestP95 = cleanNumber(latest?.p95TtmsMs);
        const latestP99 = cleanNumber(latest?.p99TtmsMs);

        return {
        type: "exploration",
        metric,
        view: "over_time",
        title: titleFor(metric, "over_time"),
        summary: buildSummaryForOverTime({
            metric,
            scopeLabel,
            pointCount: p95Series.length,
            startTs,
            endTs,
            latestP95,
            latestP99,
        }),
        series: p95Series,
        seriesSecondary: p99Series,
        sql: triage.sql
            ? {
                queries: Array.isArray(triage.sql.queries) ? triage.sql.queries : [],
                params: triage.sql.params ?? undefined,
            }
            : null,
        };
    }

    if (metric === "errors") {
        const series = points
        .map((point) => {
            const ts = cleanTs(point.ts);
            const value = cleanNumber(point.errorRatePct);
            return ts ? toSeriesPoint(ts, value) : null;
        })
        .filter(Boolean) as Array<{ ts: string; value: number | null }>;

        const latest = points.length ? points[points.length - 1] : null;
        const latestValue = cleanNumber(latest?.errorRatePct);

        return {
        type: "exploration",
        metric,
        view: "over_time",
        title: titleFor(metric, "over_time"),
        summary: buildSummaryForOverTime({
            metric,
            scopeLabel,
            pointCount: series.length,
            startTs,
            endTs,
            latestValue,
        }),
        series,
        sql: triage.sql
            ? {
                queries: Array.isArray(triage.sql.queries) ? triage.sql.queries : [],
                params: triage.sql.params ?? undefined,
            }
            : null,
        };
    }

    if (metric === "requests") {
        const series = points
        .map((point) => {
            const ts = cleanTs(point.ts);
            const value = cleanNumber(point.totalRequests);
            return ts ? toSeriesPoint(ts, value) : null;
        })
        .filter(Boolean) as Array<{ ts: string; value: number | null }>;

        const latest = points.length ? points[points.length - 1] : null;
        const latestValue = cleanNumber(latest?.totalRequests);

        return {
        type: "exploration",
        metric,
        view: "over_time",
        title: titleFor(metric, "over_time"),
        summary: buildSummaryForOverTime({
            metric,
            scopeLabel,
            pointCount: series.length,
            startTs,
            endTs,
            latestValue,
        }),
        series,
        sql: triage.sql
            ? {
                queries: Array.isArray(triage.sql.queries) ? triage.sql.queries : [],
                params: triage.sql.params ?? undefined,
            }
            : null,
        };
    }

    throw new Error(`Unsupported real over-time metric: ${metric}`);
    }


    async function buildAtsTrendOnlyResult(args: {
        context: ExplorationAgentContext;
        atsMode?: ExplorationAtsMode;
        atsFamily?: AtsOperationalFamily | null;
        }): Promise<ExplorationResult> {
        const { context, atsMode, atsFamily } = args;
        const scopeLabel = buildScopeLabel(context);

        const triage = await fetchExplorationTriage(context);

        const currentSummary = normalizeAtsSummary(triage.metricsJson?.atsSummary);
        const previousSummary = normalizeAtsSummary(
            triage.metricsJson?.previousAtsSummary
        );

        const currentTs = normalizeAtsSummaryTimeseries(
            triage.metricsJson?.atsSummaryTimeseries
        );

        const field = getAtsFamilyField(atsFamily);
        const label = getAtsFamilyLabel(atsFamily);
        const summaryLabel = getAtsFamilySummaryLabel(atsFamily);
        const displayLabel = `ATS ${label}`;

        const currentValue =
            currentSummary != null ? Number(currentSummary[field].toFixed(2)) : null;

        const previousValue =
            previousSummary != null ? Number(previousSummary[field].toFixed(2)) : null;

        const delta =
            currentValue != null && previousValue != null
            ? Number((currentValue - previousValue).toFixed(2))
            : null;

        const series = currentTs.map((p) =>
            toSeriesPoint(p.ts, Number(p[field].toFixed(2)))
        );

        return {
            type: "exploration",
            metric: "ats",
            view: "over_time",
            atsMode,
            displayLabel,
            title: `ATS ${label} Over Time`,
            summary:
            currentValue != null && previousValue != null && delta != null
                ? `ATS ${summaryLabel} is ${currentValue.toFixed(
                    2
                )}% (previous ${previousValue.toFixed(2)}%, ${
                    delta >= 0 ? "up" : "down"
                } ${Math.abs(delta).toFixed(2)}%) for ${scopeLabel}.`
                : `Showing ATS ${summaryLabel} trend for ${scopeLabel}.`,
            series,
            compareStats: [
            {
                key: label,
                current: currentValue,
                previous: previousValue,
                delta,
            },
            ],
            sql: triage.sql
            ? {
                queries: Array.isArray(triage.sql.queries) ? triage.sql.queries : [],
                params: triage.sql.params ?? undefined,
                }
            : null,
        };
        }

    async function buildLatencyBreakdownSpotlight(args: {
    context: ExplorationAgentContext;
    view: Exclude<ExplorationView, "over_time">;
    key: string;
    }) {
    const { context, view, key } = args;

    const scopedContext: ExplorationAgentContext = {
        ...context,
        region: view === "by_region" ? key : context.region,
        pop: view === "by_pop" ? key : context.pop,
        uaFamily: view === "by_ua" ? key : context.uaFamily,
        contentType: view === "by_content" ? key : context.contentType,
    };

    const triage = await fetchExplorationTriage(scopedContext);

    const points = Array.isArray(triage.metricsJson?.timeseries?.points)
        ? triage.metricsJson?.timeseries?.points ?? []
        : [];

    const p95Series = points
        .map((point) => {
        const ts = cleanTs(point.ts);
        const value = cleanNumber(point.p95TtmsMs);
        return ts ? toSeriesPoint(ts, value) : null;
        })
        .filter(Boolean) as Array<{ ts: string; value: number | null }>;

    const p99Series = points
        .map((point) => {
        const ts = cleanTs(point.ts);
        const value = cleanNumber(point.p99TtmsMs);
        return ts ? toSeriesPoint(ts, value) : null;
        })
        .filter(Boolean) as Array<{ ts: string; value: number | null }>;

    const latest = points.length ? points[points.length - 1] : null;
    const latestP95 = cleanNumber(latest?.p95TtmsMs);
    const latestP99 = cleanNumber(latest?.p99TtmsMs);
    const startTs =
        triage.metricsJson?.timeseries?.startTs ?? scopedContext.startTsUtc ?? null;
    const endTs =
        triage.metricsJson?.timeseries?.endTs ?? scopedContext.endTsUtc ?? null;

    return {
        key,
        title: `Worst ${humanizeView(view).replace("by ", "")} over time`,
        summary: buildSummaryForOverTime({
        metric: "latency",
        scopeLabel: buildScopeLabel(scopedContext),
        pointCount: p95Series.length,
        startTs,
        endTs,
        latestP95,
        latestP99,
        }),
        series: p95Series,
        seriesSecondary: p99Series,
    };
    }

    async function buildAtsOverTimeResult(args: {
    context: ExplorationAgentContext;
    atsMode?: ExplorationAtsMode;
    atsFamily?: AtsOperationalFamily | null;
    }): Promise<ExplorationResult> {
    const { context, atsMode, atsFamily } = args;
    const scopeLabel = buildScopeLabel(context);
    const triage = await fetchExplorationTriage(context);

    const currentSummary = normalizeAtsSummary(triage.metricsJson?.atsSummary);
    const previousSummary = normalizeAtsSummary(
        triage.metricsJson?.previousAtsSummary
    );

    const currentTs = normalizeAtsSummaryTimeseries(
        triage.metricsJson?.atsSummaryTimeseries
    );
    const previousTs = normalizeAtsSummaryTimeseries(
        triage.metricsJson?.previousAtsSummaryTimeseries
    );

    const field = getAtsFamilyField(atsFamily);
    const label = getAtsFamilyLabel(atsFamily);
    const summaryLabel = getAtsFamilySummaryLabel(atsFamily);
    const displayLabel = `ATS ${label}`;

    const currentSeries = currentTs.map((point) =>
        toSeriesPoint(point.ts, Number(point[field].toFixed(2)))
    );

    const previousSeries = previousTs.map((point) =>
        toSeriesPoint(point.ts, Number(point[field].toFixed(2)))
    );

    const deltaRows = buildAtsDeltaRows({
        current: currentSummary,
        previous: previousSummary,
    });

    return {
        type: "exploration",
        metric: "ats",
        view: "over_time",
        atsMode,
        displayLabel,
        title: "ATS Family Changes vs Previous Window",
        summary: `Showing ATS family changes vs previous window for ${scopeLabel}.`,
        rows: deltaRows,
        series: currentSeries,
        seriesSecondary: previousSeries,
        sql: triage.sql
            ? {
                queries: Array.isArray(triage.sql.queries) ? triage.sql.queries : [],
                params: triage.sql.params ?? undefined,
            }
            : null,
    };
    }

    async function buildAtsRawOverTimeResult(args: {
    context: ExplorationAgentContext;
    atsMode?: ExplorationAtsMode;
    atsRawCode: string;
    atsFamily?: AtsOperationalFamily | null;
    }): Promise<ExplorationResult> {
    const { context, atsMode, atsRawCode, atsFamily } = args;

    console.log("RAW ATS BRANCH HIT", { atsRawCode, atsFamily });

    const scopeLabel = buildScopeLabel(context);
    const triage = await fetchExplorationTriage(context);

    const evidenceBundle =
    (triage as any)?.evidenceBundle ??
    (triage as any)?.data?.evidenceBundle ??
    null;
    const rawPoints = Array.isArray(evidenceBundle?.atsRawTimeseries)
        ? evidenceBundle.atsRawTimeseries
        : [];

    const metricKey = `${atsRawCode}_pct`;

    const series = rawPoints
        .map((point: any) => {
        const value = point?.[metricKey];
        return {
            ts: String(point?.ts || ""),
            value:
            typeof value === "number" && Number.isFinite(value) ? value : null,
        };
        })
        .filter((point: any) => point.ts);

    const familyLabel = getAtsFamilyLabel(atsFamily);
    const summaryFamilyLabel = getAtsFamilySummaryLabel(atsFamily);

    if (!series.length) {
        return {
        type: "exploration",
        metric: "ats",
        view: "over_time",
        atsMode,
        title: `${atsRawCode.toUpperCase()} % Over Time`,
        summary: atsFamily
            ? [
                `Raw ${atsRawCode.toUpperCase()} over-time trend is not available yet in the current backend contract.`,
                `${atsRawCode.toUpperCase()} belongs to the ${summaryFamilyLabel} family for the active scope.`,
            ].join(" ")
            : `Raw ${atsRawCode.toUpperCase()} over-time trend is not available yet in the current backend contract.`,
        rows: [],
        series: [],
        sql: triage.sql
            ? {
                queries: Array.isArray(triage.sql.queries) ? triage.sql.queries : [],
                params: triage.sql.params ?? undefined,
            }
            : null,
        };
    }

    const latestPoint = [...series].reverse().find((point) => point.value != null);
    const latestValue =
        latestPoint && typeof latestPoint.value === "number"
        ? latestPoint.value
        : null;

    return {
        type: "exploration",
        metric: "ats",
        view: "over_time",
        atsMode,
        title: `${atsRawCode.toUpperCase()} % Over Time`,
        summary:
        latestValue != null
            ? atsFamily
            ? `Showing raw ${atsRawCode.toUpperCase()} trend for ${scopeLabel}. Latest value is ${latestValue.toFixed(
                2
                )}%. This code belongs to the ${summaryFamilyLabel} family.`
            : `Showing raw ${atsRawCode.toUpperCase()} trend for ${scopeLabel}. Latest value is ${latestValue.toFixed(
                2
                )}%.`
            : atsFamily
            ? `Showing raw ${atsRawCode.toUpperCase()} trend for ${scopeLabel}. This code belongs to the ${summaryFamilyLabel} family.`
            : `Showing raw ${atsRawCode.toUpperCase()} trend for ${scopeLabel}.`,
        rows: [],
        series,
        sql: triage.sql
        ? {
            queries: Array.isArray(triage.sql.queries) ? triage.sql.queries : [],
            params: triage.sql.params ?? undefined,
            }
        : null,
    };
    }


    async function buildAtsBreakdownResult(args: {
    context: ExplorationAgentContext;
    view: Exclude<ExplorationView, "over_time">;
    atsMode?: ExplorationAtsMode;
    atsFamily?: AtsOperationalFamily | null;
    }): Promise<ExplorationResult> {
    const { context, view, atsMode, atsFamily } = args;
    const scopeLabel = buildScopeLabel(context);
    const triage = await fetchExplorationTriage(context);

    const rawRows =
        view === "by_region"
        ? triage.metricsJson?.atsByRegion
        : view === "by_pop"
        ? triage.metricsJson?.atsByPop
        : view === "by_content"
        ? triage.metricsJson?.atsByContentType
        : triage.metricsJson?.atsByUaFamily;

    const rows = buildAtsBreakdownRows(rawRows, view);

    const summaryLabel = getAtsFamilySummaryLabel(atsFamily);

    return {
        type: "exploration",
        metric: "ats",
        view,
        atsMode,
        title: atsFamily ? `ATS ${summaryLabel} ${humanizeView(view)}` : titleFor("ats", view),
        summary: atsFamily
        ? `Showing ATS ${summaryLabel} breakdown for ${scopeLabel} ${humanizeView(view)}.`
        : `Showing ATS breakdown for ${scopeLabel} ${humanizeView(view)}.`,
        rows,
        sql: triage.sql
        ? {
            queries: Array.isArray(triage.sql.queries) ? triage.sql.queries : [],
            params: triage.sql.params ?? undefined,
            }
        : null,
    };
    }


    export async function runExplorationAgent(args: {
    intent: ExplorationIntent;
    context: ExplorationAgentContext;
    }): Promise<ExplorationResult> {
    const { intent, context } = args;
    const scopeLabel = buildScopeLabel(context);

    if (intent.metric === "ats") {
        if (intent.view === "over_time" && intent.atsRawCode) {
            return buildAtsRawOverTimeResult({
            context,
            atsMode: intent.atsMode,
            atsRawCode: intent.atsRawCode,
            atsFamily: intent.atsFamily ?? null,
            });
        }

        if (intent.view === "over_time") {
            const isCompare = isAtsCompareQuery(intent.rawText);

            if (isCompare) {
            return buildAtsOverTimeResult({
                context,
                atsMode: intent.atsMode,
                atsFamily: intent.atsFamily ?? null,
            });
            }

            return buildAtsTrendOnlyResult({
            context,
            atsMode: intent.atsMode,
            atsFamily: intent.atsFamily ?? null,
            });
        }

        return buildAtsBreakdownResult({
            context,
            view: intent.view,
            atsMode: intent.atsMode,
            atsFamily: intent.atsFamily ?? null,
        });
        }

    const isRealOverTimeMetric =
        intent.view === "over_time" &&
        (intent.metric === "latency" ||
        intent.metric === "errors" ||
        intent.metric === "requests");

    if (isRealOverTimeMetric) {
        return buildRealOverTimeResult({
        metric: intent.metric,
        context,
        });
    }

    if (intent.view === "over_time") {
        return {
        type: "exploration",
        metric: intent.metric,
        view: "over_time",
        atsMode: intent.atsMode,
        title: titleFor(intent.metric, intent.view),
        summary: summaryFor({
            metric: intent.metric,
            view: intent.view,
            scopeLabel,
            atsMode: intent.atsMode,
        }),
        series: [],
        sql: null,
        };
    }

    const breakdownRows = buildBreakdownRows({
        metric: intent.metric,
        view: intent.view,
        atsMode: intent.atsMode,
    });

    let spotlight:
        | {
            key: string;
            title?: string;
            summary?: string;
            series: Array<{ ts: string; value: number | null }>;
            seriesSecondary?: Array<{ ts: string; value: number | null }>;
        }
        | undefined;

    if (intent.metric === "latency") {
        const worstKey = pickWorstKey(breakdownRows, intent.metric);
        if (worstKey) {
        spotlight = await buildLatencyBreakdownSpotlight({
            context,
            view: intent.view,
            key: worstKey,
        });
        }
    }

    return {
        type: "exploration",
        metric: intent.metric,
        view: intent.view,
        atsMode: intent.atsMode,
        title: titleFor(intent.metric, intent.view),
        summary: summaryFor({
        metric: intent.metric,
        view: intent.view,
        scopeLabel,
        atsMode: intent.atsMode,
        }),
        rows: breakdownRows,
        spotlight,
        sql: null,
    };
    }