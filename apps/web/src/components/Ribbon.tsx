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
import type { Permission } from '../auth/permissions';
import type { ProcurementLevel } from '../auth/procurementLevel';
import {
  allowedGroups,
  APP_GROUPS,
  INVITATIONS_PATH,
  PLATFORM_PATH,
  QUICK_ACTIONS,
  type AppGroup,
  type AppRoute,
} from '../routes';
import type { ModuleTone } from '../theme';

/** Where the fold state is kept between visits (per browser, UI only). */
const FOLDED_STORAGE_KEY = 'erp.ribbonFolded';
/** Tab keys of the two groups the ribbon names by hand (the home tab and the admin tab). */
const HOME_TAB = 'home';
const ADMIN_TAB = 'nav.groupAdmin';

function readFolded(): boolean {
  try {
    return window.localStorage.getItem(FOLDED_STORAGE_KEY) === '1';
  } catch {
    // Storage blocked or unreadable: the ribbon opens expanded.
    return false;
  }
}

function writeFolded(folded: boolean): void {
  try {
    window.localStorage.setItem(FOLDED_STORAGE_KEY, folded ? '1' : '0');
  } catch {
    // Not critical: the ribbon just opens expanded next time.
  }
}

/** One button of the strip: a real link, so Ctrl+click opens it in a new tab. */
interface RibbonItem {
  /** Unique within its tab: a route key, or a prefixed key for the home and "new" buttons. */
  key: string;
  path: string;
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
  /** Signed in without a company: only the invitations screen is offered. */
  noCompany: boolean;
  isPlatformAdmin: boolean;
  pendingInvitations: number;
  /** Tablets (768–991 px): smaller buttons, and the strip scrolls sideways when it does not fit. */
  compact: boolean;
}

function isSelected(item: RibbonItem, pathname: string): boolean {
  return !item.isNew && (pathname === item.path || pathname.startsWith(`${item.path}/`));
}

function RibbonButton({ item, pathname }: { item: RibbonItem; pathname: string }) {
  const selected = isSelected(item, pathname);
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
    <Link to={item.path} className="ribbon-link" aria-current={selected ? 'page' : undefined}>
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
export function Ribbon({ can, procurementLevel, noCompany, isPlatformAdmin, pendingInvitations, compact }: RibbonProps) {
  const { t, i18n } = useTranslation();
  const { pathname } = useLocation();
  const isRtl = i18n.language !== 'en';
  const uid = useId();
  const rootRef = useRef<HTMLElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  // The same filter as the side menu: the role's permissions and procurement level (ADR-024 §2.3).
  const tabs = useMemo<RibbonTab[]>(() => {
    const visibleGroups: AppGroup[] = noCompany
      ? APP_GROUPS.map((g) => ({ ...g, routes: g.routes.filter((r) => r.path === INVITATIONS_PATH) })).filter(
          (g) => g.routes.length > 0,
        )
      : allowedGroups(APP_GROUPS, can, procurementLevel);

    const routeItem = (route: AppRoute, tone: ModuleTone, count?: number): RibbonItem => ({
      key: route.key,
      path: route.path,
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
      for (const route of group.routes) {
        const count = route.badge === 'pendingInvitations' && pendingInvitations > 0 ? pendingInvitations : undefined;
        add(route.section ?? group.label, routeItem(route, group.tone, count));
        if (route.newPath) {
          add(route.section ?? group.label, {
            key: `${route.key}:new`,
            path: route.newPath,
            label: t('ribbon.newOf', { name: t(route.label) }),
            icon: route.icon,
            tone: group.tone,
            isNew: true,
          });
        }
      }
      return [...sections.values()];
    };

    const list: RibbonTab[] = [];

    if (!noCompany) {
      const sections: RibbonSection[] = [
        {
          key: 'nav.home',
          caption: t('nav.home'),
          items: [{ key: HOME_TAB, path: '/', label: t('nav.home'), icon: <HomeOutlined />, tone: 'home', isNew: false }],
        },
      ];
      // Quick actions: only the new documents this role may create (the API answers the rest with 403).
      const quick = QUICK_ACTIONS.filter((a) => can(a.permission)).map<RibbonItem>((a) => ({
        key: `quick:${a.key}`,
        path: a.path,
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
  }, [t, can, procurementLevel, noCompany, isPlatformAdmin, pendingInvitations]);

  // The tabs whose buttons lead to the current page: several for a screen listed twice (parties).
  const pathTabKeys = tabs
    .filter((tab) => tab.sections.some((s) => s.items.some((i) => isSelected(i, pathname))))
    .map((tab) => tab.key);
  const pathSignature = pathTabKeys.join('\n');

  const [activeKey, setActiveKey] = useState<string>(() => pathTabKeys[0] ?? HOME_TAB);
  // Following the page: a screen switches the strip to its tab, unless the current tab already holds it.
  // Clicking another tab only switches the strip (it does not navigate), so this runs on navigation only.
  useEffect(() => {
    if (!pathSignature) return;
    const keys = pathSignature.split('\n');
    setActiveKey((previous) => (keys.includes(previous) ? previous : keys[0]));
  }, [pathname, pathSignature]);

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
              <RibbonButton key={item.key} item={item} pathname={pathname} />
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
          aria-label={t('ribbon.fold')}
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
