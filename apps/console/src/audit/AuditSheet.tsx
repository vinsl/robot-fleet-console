/**
 * The audit sheet: the audited actions of the site, newest first, one page of records at a time, narrowed by a robot
 * and an outcome when the operator sets them.
 *
 * Every signed-in role reads it. A result is shown with its icon and its text, never with its colour alone, and the
 * correlation identifier is set in the monospace face so that it can be copied and matched with the logs.
 */
import type * as React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AuditListResponse, AuditRecord, AuditResult } from "@mfc/protocol";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import type { AuditFilters } from "../api/audit";
import { Sheet } from "../layout/Sheet";
import { useDismiss } from "../layout/use-dismiss";
import { AuditFilterBar } from "./AuditFilterBar";
import { auditActionKey, auditResultVisual, formatAuditTime, whoLabel } from "./audit-text";
import { useAuditTrail } from "./use-audit";
import styles from "./AuditSheet.module.css";

/**
 * Renders the audit sheet.
 *
 * @returns The sheet.
 */
export function AuditSheet(): React.JSX.Element {
  const { t } = useTranslation("audit");
  const dismiss = useDismiss();
  const [filters, setFilters] = useState<AuditFilters>({});
  const query = useAuditTrail(filters);
  return (
    <Sheet title={t("title")} onClose={dismiss}>
      <AuditFilterBar value={filters} onChange={setFilters} />
      <AuditBody query={query} filters={filters} />
    </Sheet>
  );
}

/** Props of {@link AuditBody}. */
interface AuditBodyProps {
  /** The paged audit query of the sheet. */
  readonly query: UseInfiniteQueryResult<InfiniteData<AuditListResponse>>;
  /** The filters the query was made with. */
  readonly filters: AuditFilters;
}

/**
 * The content of the sheet: the loading and failure states, the table, and "Load more" while the API has a next
 * page. With a filter set, an empty page is not the end of the story: the API only scanned the records of the pages
 * read so far, so the sheet says so and offers the next page under the name of a search.
 *
 * @param props - The query and the filters it was made with.
 * @returns The content.
 */
function AuditBody({ query, filters }: AuditBodyProps): React.JSX.Element {
  const { t } = useTranslation("audit");
  const data = query.data;
  if (data === undefined) {
    return query.isError ? (
      <div role="alert" className={styles.failure}>
        <p>{t("error.load")}</p>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            void query.refetch();
          }}
        >
          {t("retry")}
        </button>
      </div>
    ) : (
      <p role="status">{t("loading")}</p>
    );
  }

  const records = data.pages.flatMap((page) => page.items);
  const filtered = filters.robotId !== undefined || filters.result !== undefined;
  // A filtered page with no match and a next page is a search that has not finished: the button continues it.
  const searching = filtered && records.length === 0;
  return (
    <>
      {filtered ? <FilterStatus filters={filters} /> : null}
      {records.length === 0 ? (
        <EmptyMessage filtered={filtered} hasNextPage={query.hasNextPage} />
      ) : (
        <AuditTable records={records} />
      )}
      {query.hasNextPage ? (
        <button
          type="button"
          className={styles.button}
          disabled={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        >
          {searching ? t("filter.searchOlder") : t("loadMore")}
        </button>
      ) : null}
    </>
  );
}

/** Props of {@link EmptyMessage}. */
interface EmptyMessageProps {
  /** Whether a filter is set. */
  readonly filtered: boolean;
  /** Whether the API has more records to read. */
  readonly hasNextPage: boolean;
}

/**
 * The message of a page with no record. Without a filter it is the empty trail. With a filter it says whether the
 * records read so far hold no match, or whether no record of the trail matches.
 *
 * @param props - Whether a filter is set and whether more records may follow.
 * @returns The message.
 */
function EmptyMessage({ filtered, hasNextPage }: EmptyMessageProps): React.JSX.Element {
  const { t } = useTranslation("audit");
  if (!filtered) {
    return <p>{t("empty")}</p>;
  }
  return <p>{t(hasNextPage ? "filter.noneYet" : "filter.none")}</p>;
}

/** Props of {@link FilterStatus}. */
interface FilterStatusProps {
  /** The filters in force, at least one of them set. */
  readonly filters: AuditFilters;
}

/**
 * Says in words which records the table shows. It is a live region, so a screen reader announces the new filter
 * when the first page of it arrives.
 *
 * @param props - The filters in force.
 * @returns The status line.
 */
function FilterStatus({ filters }: FilterStatusProps): React.JSX.Element {
  const { t } = useTranslation("audit");
  const robot = filters.robotId ?? t("filter.allRobots");
  const result =
    filters.result === undefined
      ? t("filter.allResults")
      : t(auditResultVisual(filters.result).labelKey);
  return (
    <p role="status" aria-live="polite" className={styles.active}>
      {t("filter.active", { robot, result })}
    </p>
  );
}

/** Props of {@link AuditTable}. */
interface AuditTableProps {
  /** Records to show, in the order the API sent them. */
  readonly records: readonly AuditRecord[];
}

/**
 * The table of records. The wrapper is focusable so that a keyboard user can scroll a narrow table.
 *
 * @param props - The records.
 * @returns The table.
 */
function AuditTable({ records }: AuditTableProps): React.JSX.Element {
  const { t, i18n } = useTranslation("audit");
  return (
    <div role="region" aria-label={t("table.name")} tabIndex={0} className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t("column.time")}</th>
            <th scope="col">{t("column.who")}</th>
            <th scope="col">{t("column.action")}</th>
            <th scope="col">{t("column.robot")}</th>
            <th scope="col">{t("column.result")}</th>
            <th scope="col">{t("column.correlationId")}</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.auditId}>
              <td>
                <time dateTime={record.ts}>{formatAuditTime(record.ts, i18n.language)}</time>
              </td>
              <td>{whoLabel(record, t)}</td>
              <td>{t(auditActionKey(record.action))}</td>
              <td>{record.robotId ?? t("noRobot")}</td>
              <td>
                <ResultChip result={record.result} />
              </td>
              <td>
                <code className={styles.mono}>{record.correlationId}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Props of {@link ResultChip}. */
interface ResultChipProps {
  /** Outcome to show. */
  readonly result: AuditResult;
}

/**
 * The outcome of a record: its icon and its label. The colour reinforces the meaning and never carries it alone.
 *
 * @param props - The outcome.
 * @returns The chip.
 */
function ResultChip({ result }: ResultChipProps): React.JSX.Element {
  const { t } = useTranslation("audit");
  const visual = auditResultVisual(result);
  const Icon = visual.icon;
  return (
    <span className={styles.result} style={{ color: visual.color }}>
      <Icon aria-hidden="true" focusable="false" className={styles.icon} />
      <span>{t(visual.labelKey)}</span>
    </span>
  );
}
