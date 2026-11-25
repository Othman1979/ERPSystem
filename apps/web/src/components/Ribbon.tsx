import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { Badge } from 'antd';
import { CloudServerOutlined, DownOutlined, HomeOutlined, UpOutlined } from '@ant-design/icons';
import { PERMISSIONS, type Permission } from '../auth/permissions';
import type { ProcurementLevel } from '../auth/procurementLevel';
import {
  allowedGroups,
  APP_GROUPS,
  INVITATIONS_PATH,
  PLATFORM_PATH,
  QUICK_ACTIONS,
  type AppGroup,
  type AppRoute,
  type RibbonLink,
} from '../routes';
import type { ModuleTone } from '../theme';

/** Where the fold state is kept between visits (per browser, UI only). */
const FOLDED_STORAGE_KEY = 'erp.ribbonFolded';
/** Tab keys of the two groups the ribbon names by hand (the home tab and the admin tab). */
const HOME_TAB = 'home';
const ADMIN_TAB = 'nav.groupAdmin';

function readFolded(): boolean {
  try {
    return window.localStorage.getItem(FOLDED_STORAGE_KEY) !== '0';
  } catch {
    // Storage blocked or unreadable: keep the ribbon compact by default.
    return true;
  }
}

function writeFolded(folded: boolean): void {
  try {
    window.localStorage.setItem(FOLDED_STORAGE_KEY, folded ? '1' : '0');
  } catch {
    // Not critical: the ribbon keeps the default folded state next time.
  }
}

/** One button of the strip: a real link, so Ctrl+click opens it in a new tab. */
interface RibbonItem {
  /** Unique within its section: a route/link key, or a prefixed key for a "new" button. */
  key: string;
  /** The path used to determine whether this item is selected. */
  path: string;
  /** Full href, including an optional query string. */
  to: string;
  /** A view link's target tab; absent for route buttons. */
  viewTab?: string;
  label: string;
  icon: ReactNode;
  tone: ModuleTone;
  /** A "new document" button: carries the ink + badge and is never the selected one. */
  isNew: boolean;
  /** Count shown on the tile (pending invitations). */
  count?: number;
}

interface RibbonSection {
  /** i18n key of the caption, also the identity of the sub-group. */
  key: string;
  caption: string;
  items: RibbonItem[];
}

interface RibbonTab {
  key: string;
  label: string;
  tone: ModuleTone;
  sections: RibbonSection[];
}

export interface RibbonProps {
  /** The role's permission check (useAuth().can). */
  can: (permission: Permission) => boolean;
  /** The company's procurement level, when known. */
  procurementLevel?: ProcurementLevel;
  allBranches?: boolean;
  consignmentEnabled?: boolean;
  costCentersEnabled?: boolean;
  /** Signed in without a company: only the invitations screen is offered. */
  noCompany: boolean;
  isPlatformAdmin: boolean;
  pendingInvitations: number;
  /** Tablets (768–991 px): smaller buttons, and the strip scrolls sideways when it does not fit. */
  compact: boolean;
}

const DEFAULT_VIEW_TABS: Record<string, string> = {
  '/items': 'items',
  '/consignment': 'open',
  '/payroll': 'employees',
  '/purchases': 'invoices',
  '/reports': 'tb',
  '/sales': 'invoices',
  '/stock': 'balances',
  '/treasury': 'boxes',
};

function pathMatches(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function isSelected(
  item: RibbonItem,
  pathname: string,
  search: string,
  allBranches: boolean,
  can: RibbonProps['can'],
): boolean {
  if (item.isNew || !pathMatches(pathname, item.path)) return false;
  if (item.viewTab === undefined) return true;

  const currentTab = new URLSearchParams(search).get('tab');
  if (currentTab) return currentTab === item.viewTab;

  const defaultTab =
    item.path === '/reports' && !allBranches
      ? 'statement'
      : item.path === '/consignment' && !can(PERMISSIONS.PURCHASE_MANAGE)
        ? 'statement'
        : DEFAULT_VIEW_TABS[item.path];
  return item.viewTab === defaultTab;
}

function linkItem(link: RibbonLink, tone: ModuleTone, t: (key: string) => string): RibbonItem {
  const [path] = link.to.split('?');
  const tab = new URLSearchParams(link.to.split('?')[1] ?? '').get('tab') ?? undefined;
  return {
    key: link.key,
    path,
    to: link.to,
    viewTab: tab,
    label: t(link.label),
    icon: link.icon,
    tone,
    isNew: false,
  };
}

export function filterRibbonLinksByAllowedRoutes(
  links: readonly RibbonLink[],
  allowedRoutePaths: ReadonlySet<string>,
): RibbonLink[] {
  return links.filter((link) => allowedRoutePaths.has(link.to.split('?')[0]));
}

function RibbonButton({
  item,
  pathname,
  search,
  allBranches,
  can,
}: {
  item: RibbonItem;
  pathname: string;
  search: string;
  allBranches: boolean;
  can: RibbonProps['can'];
}) {
  const selected = isSelected(item, pathname, search, allBranches, can);
  const tile = (
    <span className="ribbon-tile" data-tone={item.tone}>
      {item.icon}
      {item.isNew && (
        <span className="ribbon-new" aria-hidden="true">
          +
        </span>
      )}
    </span>
  );
  return (
    <Link to={item.to} className="ribbon-link" aria-current={selected ? 'page' : undefined}>
      {item.count ? (
        <Badge count={item.count} size="small" offset={[-4, 4]}>
          {tile}
        </Badge>
      ) : (
        tile
      )}
      <span className="ribbon-label">{item.label}</span>
    </Link>
  );
}

/**
 * The ribbon of the desktop and tablet shell (ADR-029): a row of module tabs
 * under the top bar, and the buttons of the active tab on a strip below it.
 * Replaces the side menu on screens from 768 px; the phone keeps its drawer.
 */
export function Ribbon({
  can,
  procurementLevel,
  allBranches = true,
  consignmentEnabled = false,
  costCentersEnabled = false,
  noCompany,
  isPlatformAdmin,
  pendingInvitations,
  compact,
}: RibbonProps) {
  const { t, i18n } = useTranslation();
  const { pathname, search } = useLocation();
  const isRtl = i18n.language !== 'en';
  const uid = useId();
  const rootRef = useRef<HTMLElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  // The same filter as the side menu: the role's permissions and procurement level (ADR-024 §2.3).
  const tabs = useMemo<RibbonTab[]>(() => {
    const visibleGroups: AppGroup[] = noCompany
      ? APP_GROUPS.map((g) => ({ ...g, routes: g.routes.filter((r) => r.path === INVITATIONS_PATH), links: [] })).filter(
          (g) => g.routes.length > 0,
        )
      : allowedGroups(APP_GROUPS, can, procurementLevel, allBranches, consignmentEnabled);
    const allowedRoutePaths = new Set(visibleGroups.flatMap((group) => group.routes.map((route) => route.path)));

    const routeItem = (route: AppRoute, tone: ModuleTone, count?: number): RibbonItem => ({
      key: route.key,
      path: route.path,
      to: route.path,
      label: t(route.label),
      icon: route.icon,
      tone,
      isNew: false,
      count,
    });

    const groupSections = (group: AppGroup): RibbonSection[] => {
      const sections = new Map<string, RibbonSection>();
      const add = (captionKey: string, item: RibbonItem) => {
        const section = sections.get(captionKey) ?? { key: captionKey, caption: t(captionKey), items: [] };
        section.items.push(item);
        sections.set(captionKey, section);
      };
      for (const link of filterRibbonLinksByAllowedRoutes(group.links ?? [], allowedRoutePaths)) {
        if (link.permission && !can(link.permission)) continue;
        if (link.companyWide && !allBranches) continue;
        if (link.requires === 'costCenters' && !costCentersEnabled) continue;
        if (link.requires === 'consignment' && !consignmentEnabled) continue;
        add(link.section, linkItem(link, group.tone, t));
      }
      for (const route of group.routes) {
        if (route.ribbon === false) continue;
        const count = route.badge === 'pendingInvitations' && pendingInvitations > 0 ? pendingInvitations : undefined;
        add(route.section ?? group.label, routeItem(route, group.tone, count));
      }
      for (const route of group.routes) {
        // Offered only to roles that may create the document (the API answers others with 403).
        if (route.newPath && (!route.newPermission || can(route.newPermission))) {
          const [path] = route.newPath.split('?');
          add(route.section ?? group.label, {
            key: `${route.key}:new`,
            path,
            to: route.newPath,
            // A document's own name ("New sales invoice") reads better than "New: Sales".
            label: i18n.exists(`ribbon.new.${route.key}`) ? t(`ribbon.new.${route.key}`) : t('ribbon.newOf', { name: t(route.label) }),
            icon: route.icon,
            tone: group.tone,
            isNew: true,
          });
        }
      }
      const sectionOrder: Record<string, string[]> = {
        'nav.groupAccounting': ['nav.sectionLedger', 'nav.sectionPeriods', 'nav.sectionReports'],
        'nav.groupInventory': ['nav.sectionCatalog', 'nav.sectionMovements', 'nav.sectionReports'],
        'nav.groupPayroll': ['nav.sectionSetup', 'nav.sectionOperations', 'nav.sectionReports'],
        'nav.groupPurchases': ['nav.sectionDocuments', 'nav.sectionCycle', 'nav.sectionPartners', 'nav.sectionReports'],
        'nav.groupSales': ['nav.sectionDocuments', 'nav.sectionSalesCycle', 'nav.sectionPartners', 'nav.sectionReports'],
        'nav.groupTreasury': ['nav.sectionSetup', 'nav.sectionDocuments', 'nav.sectionReports'],
      };
      const order = sectionOrder[group.label] ?? [];
      return [...sections.values()].sort((left, right) => {
        const leftIndex = order.indexOf(left.key);
        const rightIndex = order.indexOf(right.key);
        if (leftIndex === -1 && rightIndex === -1) return 0;
        if (leftIndex === -1) return 1;
        if (rightIndex === -1) return -1;
        return leftIndex - rightIndex;
      });
    };

    const list: RibbonTab[] = [];

    if (!noCompany) {
      const sections: RibbonSection[] = [
        {
          key: 'nav.home',
          caption: t('nav.home'),
          items: [{ key: HOME_TAB, path: '/', to: '/', label: t('nav.home'), icon: <HomeOutlined />, tone: 'home', isNew: false }],
        },
      ];
      // Quick actions: only the new documents this role may create (the API answers the rest with 403).
      const quick = QUICK_ACTIONS.filter((a) => can(a.permission) && (a.key !== 'payrollRun' || allBranches)).map<RibbonItem>((a) => ({
        key: `quick:${a.key}`,
        path: a.path,
        to: a.path,
        label: t(a.label),
        icon: a.icon,
        tone: a.tone,
        isNew: true,
      }));
      if (quick.length > 0) sections.push({ key: 'dashboard.quickActions', caption: t('dashboard.quickActions'), items: quick });
      list.push({ key: HOME_TAB, label: t('nav.home'), tone: 'home', sections });
    }

    for (const group of visibleGroups) {
      list.push({ key: group.label, label: t(group.label), tone: group.tone, sections: groupSections(group) });
    }

    // The platform owner's console (§13.3) sits in the admin tab.
    if (isPlatformAdmin) {
      const platform: RibbonItem = {
        key: 'platform',
        path: PLATFORM_PATH,
        to: PLATFORM_PATH,
        label: t('platform.nav'),
        icon: <CloudServerOutlined />,
        tone: 'admin',
        isNew: false,
      };
      let admin = list.find((tab) => tab.key === ADMIN_TAB);
      if (!admin) {
        admin = { key: ADMIN_TAB, label: t(ADMIN_TAB), tone: 'admin', sections: [] };
        list.push(admin);
      }
      const captionKey = 'nav.sectionSystem';
      const section = admin.sections.find((s) => s.key === captionKey);
      if (section) section.items.push(platform);
      else admin.sections.push({ key: captionKey, caption: t(captionKey), items: [platform] });
    }

    return list.filter((tab) => tab.sections.some((s) => s.items.length > 0));
    // Labels depend on the language; t identity changes with it.
  }, [t, i18n, can, procurementLevel, allBranches, consignmentEnabled, costCentersEnabled, noCompany, isPlatformAdmin, pendingInvitations]);

  // The tabs whose buttons lead to the current page: several for a screen listed twice (parties).
  const pathTabKeys = tabs
    .filter((tab) =>
      tab.sections.some((s) =>
        s.items.some((i) => isSelected(i, pathname, search, allBranches, can)),
      ),
    )
    .map((tab) => tab.key);
  const pathSignature = pathTabKeys.join('\n');

  const [activeKey, setActiveKey] = useState<string>(() => pathTabKeys[0] ?? HOME_TAB);
  // Following the page: a screen switches the strip to its tab, unless the current tab already holds it.
  // Clicking another tab only switches the strip (it does not navigate), so this runs on navigation only.
  useEffect(() => {
    if (!pathSignature) return;
    const keys = pathSignature.split('\n');
    setActiveKey((previous) => (keys.includes(previous) ? previous : keys[0]));
  }, [pathname, search, pathSignature]);

  const current = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];

  const [folded, setFolded] = useState<boolean>(readFolded);
  const [floatOpen, setFloatOpen] = useState(false);

  const changeFolded = (next: boolean) => {
    setFolded(next);
    writeFolded(next);
    setFloatOpen(false);
  };

  // Folded, the strip floats over the page; it closes on Escape or a click outside the ribbon.
  useEffect(() => {
    if (!floatOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setFloatOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const focusInside = rootRef.current?.contains(document.activeElement);
      setFloatOpen(false);
      // The panel unmounts: keep the keyboard position on the tab.
      if (focusInside && current) tabRefs.current.get(current.key)?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [floatOpen, current]);

  if (!current) return null;

  const tabDomId = (key: string) => `${uid}-tab-${key.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const panelId = `${uid}-panel`;

  const selectTab = (key: string) => {
    // Folded: a tab opens the floating strip, and the open tab closes it again.
    if (folded) setFloatOpen((open) => !(open && key === current.key));
    setActiveKey(key);
  };

  // Arrow keys move between tabs and show their strip; mirrored in Arabic (RTL).
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.findIndex((tab) => tab.key === current.key);
    const forward = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const back = isRtl ? 'ArrowRight' : 'ArrowLeft';
    let target: number | null = null;
    if (event.key === forward) target = (index + 1) % tabs.length;
    else if (event.key === back) target = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = tabs.length - 1;
    if (target === null) return;
    event.preventDefault();
    const next = tabs[target];
    setActiveKey(next.key);
    tabRefs.current.get(next.key)?.focus();
  };

  const showStrip = !folded || floatOpen;
  const strip = (
    <div
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabDomId(current.key)}
      className="ribbon-strip"
      // A choice closes the floating strip; the link itself still navigates.
      onClick={() => {
        if (folded) setFloatOpen(false);
      }}
    >
      {current.sections.map((section) => (
        <div className="ribbon-group" key={section.key}>
          <div className="ribbon-buttons">
            {section.items.map((item) => (
              <RibbonButton
                key={item.key}
                item={item}
                pathname={pathname}
                search={search}
                allBranches={allBranches}
                can={can}
              />
            ))}
          </div>
          <div className="ribbon-caption">{section.caption}</div>
        </div>
      ))}
    </div>
  );

  return (
    <section ref={rootRef} className={`ribbon${compact ? ' is-compact' : ''}`} aria-label={t('ribbon.label')}>
      <div className="ribbon-tab-row">
        <div role="tablist" aria-label={t('ribbon.tabs')} className="ribbon-tabs">
          {tabs.map((tab) => {
            const active = tab.key === current.key;
            return (
              <button
                key={tab.key}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.key, el);
                  else tabRefs.current.delete(tab.key);
                }}
                id={tabDomId(tab.key)}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={showStrip && active ? panelId : undefined}
                tabIndex={active ? 0 : -1}
                className="ribbon-tab"
                data-tone={tab.tone}
                onClick={() => selectTab(tab.key)}
                onDoubleClick={() => changeFolded(!folded)}
                onKeyDown={onTabKeyDown}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="ribbon-fold"
          aria-expanded={!folded}
          aria-label={folded ? t('ribbon.unfold') : t('ribbon.fold')}
          title={folded ? t('ribbon.unfold') : t('ribbon.fold')}
          onClick={() => changeFolded(!folded)}
        >
          {folded ? <DownOutlined /> : <UpOutlined />}
        </button>
      </div>
      {!folded && strip}
      {folded && floatOpen && <div className="ribbon-float">{strip}</div>}
    </section>
  );
}
