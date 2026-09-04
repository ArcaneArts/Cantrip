import { ChevronRight } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { SettingsSearchField, type SettingsTab } from "./settings-controls";

export interface SettingsSearchItem {
  description?: string;
  id: string;
  keywords?: readonly string[];
  label: string;
}

export interface SettingsNavigationSection<
  SectionId extends string,
> extends SettingsTab<SectionId> {
  description: string;
  searchItems: readonly SettingsSearchItem[];
}

export interface SettingsSearchResult<
  SectionId extends string,
> extends SettingsSearchItem {
  sectionId: SectionId;
  sectionLabel: string;
}

function normalizedSearchTokens(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
}

function matchesTokens(tokens: readonly string[], values: readonly string[]) {
  const haystack = values.join(" ").toLocaleLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function settingsSearchResults<SectionId extends string>(
  query: string,
  sections: readonly SettingsNavigationSection<SectionId>[],
): SettingsSearchResult<SectionId>[] {
  const tokens = normalizedSearchTokens(query);
  if (!tokens.length) return [];

  return sections.flatMap((section) => {
    const sectionMatches = matchesTokens(tokens, [
      section.label,
      section.description,
    ]);
    const items = section.searchItems.length
      ? section.searchItems
      : [
          {
            description: section.description,
            id: `${section.id}-settings`,
            label: section.label,
          },
        ];
    return items.flatMap((item) =>
      sectionMatches ||
      matchesTokens(tokens, [
        section.label,
        section.description,
        item.label,
        item.description ?? "",
        ...(item.keywords ?? []),
      ])
        ? [
            {
              ...item,
              sectionId: section.id,
              sectionLabel: section.label,
            },
          ]
        : [],
    );
  });
}

function SettingsSectionList<SectionId extends string>({
  activeSection,
  onSelect,
  sections,
}: {
  activeSection: SectionId;
  onSelect(section: SectionId): void;
  sections: readonly SettingsNavigationSection<SectionId>[];
}) {
  return (
    <div className="grid gap-1" role="list">
      {sections.map(({ description, icon: Icon, id, label }) => (
        <button
          key={id}
          type="button"
          aria-current={activeSection === id ? "page" : undefined}
          className={cn(
            "group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
            activeSection === id
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
          onClick={() => onSelect(id)}
        >
          <Icon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{label}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {description}
            </span>
          </span>
          <ChevronRight className="size-3.5 shrink-0 opacity-50 md:hidden" />
        </button>
      ))}
    </div>
  );
}

function SettingsSearchResultList<SectionId extends string>({
  onSelect,
  query,
  results,
}: {
  onSelect(result: SettingsSearchResult<SectionId>): void;
  query: string;
  results: readonly SettingsSearchResult<SectionId>[];
}) {
  return (
    <div className="grid gap-2" data-slot="settings-search-results">
      <div>
        <h2 className="text-sm font-semibold">Search results</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {results.length
            ? `${results.length} matching ${results.length === 1 ? "setting" : "settings"} across all categories.`
            : `No settings match “${query.trim()}”.`}
        </p>
      </div>
      {results.length ? (
        <div className="divide-y border-y">
          {results.map((result) => (
            <button
              key={`${result.sectionId}:${result.id}`}
              type="button"
              className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/60"
              onClick={() => onSelect(result)}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {result.label}
                </span>
                {result.description ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {result.description}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {result.sectionLabel}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SettingsNavigationLayout<SectionId extends string>({
  activeSection,
  ariaLabel,
  children,
  initialMobileSectionOpen = false,
  mobileSectionOpen: controlledMobileSectionOpen,
  onMobileSectionOpenChange,
  onSearchQueryChange,
  onSectionChange,
  searchPlaceholder = "Search all settings",
  searchQuery,
  sections,
  title,
}: {
  activeSection: SectionId;
  ariaLabel: string;
  children: ReactNode;
  initialMobileSectionOpen?: boolean;
  mobileSectionOpen?: boolean;
  onMobileSectionOpenChange?(open: boolean): void;
  onSearchQueryChange(query: string): void;
  onSectionChange(section: SectionId): void;
  searchPlaceholder?: string;
  searchQuery: string;
  sections: readonly SettingsNavigationSection<SectionId>[];
  title: string;
}) {
  const [uncontrolledMobileSectionOpen, setUncontrolledMobileSectionOpen] =
    useState(initialMobileSectionOpen);
  const mobileSectionOpen =
    controlledMobileSectionOpen ?? uncontrolledMobileSectionOpen;
  const setMobileSectionOpen = (open: boolean) => {
    if (controlledMobileSectionOpen === undefined) {
      setUncontrolledMobileSectionOpen(open);
    }
    onMobileSectionOpenChange?.(open);
  };
  const normalizedQuery = searchQuery.trim();
  const active = sections.find(({ id }) => id === activeSection) ?? null;
  const results = useMemo(
    () => settingsSearchResults(searchQuery, sections),
    [searchQuery, sections],
  );
  const selectSection = (section: SectionId) => {
    onSearchQueryChange("");
    onSectionChange(section);
    setMobileSectionOpen(true);
  };
  const selectSearchResult = (result: SettingsSearchResult<SectionId>) =>
    selectSection(result.sectionId);

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      data-slot="settings-navigation-layout"
    >
      <aside
        aria-label={ariaLabel}
        className="hidden w-60 shrink-0 flex-col border-r bg-muted/[0.08] md:flex"
        data-slot="settings-sidebar"
      >
        <div className="border-b p-3">
          <SettingsSearchField
            ariaLabel={searchPlaceholder}
            className="max-w-none"
            placeholder={searchPlaceholder}
            value={searchQuery}
            onValueChange={onSearchQueryChange}
          />
        </div>
        <nav
          className="min-h-0 flex-1 overflow-y-auto p-2"
          data-slot="sidebar-scroll-region"
        >
          <SettingsSectionList
            activeSection={activeSection}
            sections={sections}
            onSelect={selectSection}
          />
        </nav>
      </aside>

      <section
        aria-label={`${title} categories`}
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:hidden",
          mobileSectionOpen && !normalizedQuery ? "hidden" : "flex",
        )}
        data-slot="settings-mobile-categories"
      >
        <div className="border-b p-4">
          <h1 className="sr-only">{title}</h1>
          <SettingsSearchField
            ariaLabel={searchPlaceholder}
            className="max-w-none"
            placeholder={searchPlaceholder}
            value={searchQuery}
            onValueChange={onSearchQueryChange}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {normalizedQuery ? (
            <SettingsSearchResultList
              query={searchQuery}
              results={results}
              onSelect={selectSearchResult}
            />
          ) : (
            <SettingsSectionList
              activeSection={activeSection}
              sections={sections}
              onSelect={selectSection}
            />
          )}
        </div>
      </section>

      <main
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex",
          !mobileSectionOpen || normalizedQuery ? "hidden md:flex" : "flex",
        )}
        data-slot="settings-content"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-2 md:hidden">
          <span className="truncate px-2 text-sm font-medium">
            {active?.label ?? title}
          </span>
        </div>
        {normalizedQuery ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <SettingsSearchResultList
              query={searchQuery}
              results={results}
              onSelect={selectSearchResult}
            />
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
