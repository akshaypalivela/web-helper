import type { UIElement, UIMap, UIRegion } from "./types";

const BUTTON_SELECTORS = ["button", "[role='button']", "input[type='button']", "input[type='submit']"];
const LINK_SELECTORS = ["a[href]", "[role='link']"];
const INPUT_SELECTORS = ["input", "textarea", "select"];
const NAV_SELECTORS = ["nav a", "[role='navigation'] a", "aside a"];
const MODAL_SELECTORS = ["[role='dialog']", ".modal", "[aria-modal='true']"];
const TABLE_SELECTORS = ["table", "[role='table']"];

function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  const style = window.getComputedStyle(html);
  const rect = html.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

function textForElement(el: Element): string {
  const html = el as HTMLElement;
  return (
    html.getAttribute("aria-label") ||
    html.textContent?.replace(/\s+/g, " ").trim() ||
    (html as HTMLInputElement).value ||
    ""
  );
}

function classifyRegion(el: Element): UIRegion {
  if (el.closest("[role='dialog'], .modal, [aria-modal='true']")) return "modal";
  if (el.closest("table, [role='table']")) return "table";
  if (el.closest("nav, [role='navigation']")) return "navigation";
  if (el.closest("aside")) return "sidebar";
  if (el.closest("main")) return "main";
  return "unknown";
}

function toSelector(el: Element): string {
  const html = el as HTMLElement;
  if (html.id) return `#${html.id}`;
  const testId = html.getAttribute("data-testid");
  if (testId) return `[data-testid="${testId}"]`;
  if (html.getAttribute("name")) return `${html.tagName.toLowerCase()}[name="${html.getAttribute("name")}"]`;
  return html.tagName.toLowerCase();
}

function mapElement(el: Element, role: UIElement["role"]): UIElement {
  const html = el as HTMLElement;
  const rect = html.getBoundingClientRect();
  return {
    id: crypto.randomUUID(),
    selector: toSelector(el),
    label: textForElement(el),
    role,
    visible: isVisible(el),
    position: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    region: classifyRegion(el),
    ariaLabel: html.getAttribute("aria-label") || undefined,
    href: html.getAttribute("href") || undefined,
    inputType: html.getAttribute("type") || undefined,
    metadata: {
      tagName: html.tagName.toLowerCase(),
    },
  };
}

function collectElements(selectors: string[], role: UIElement["role"]): UIElement[] {
  const elements = Array.from(document.querySelectorAll(selectors.join(",")));
  return elements.map((el) => mapElement(el, role)).filter((el) => el.visible);
}

export function scanCurrentPage(): UIMap {
  const buttons = collectElements(BUTTON_SELECTORS, "button");
  const links = collectElements(LINK_SELECTORS, "link");
  const inputs = collectElements(INPUT_SELECTORS, "input");
  const navItems = collectElements(NAV_SELECTORS, "nav_item");
  const modals = collectElements(MODAL_SELECTORS, "modal_action");
  const tables = collectElements(TABLE_SELECTORS, "table_action");

  const elements = [...buttons, ...links, ...inputs, ...navItems, ...modals, ...tables];
  const visibleText = document.body?.innerText?.replace(/\s+/g, " ").trim() || "";

  return {
    currentUrl: window.location.href,
    pageTitle: document.title,
    visibleText,
    buttons,
    links,
    inputs,
    navItems,
    modals,
    tables,
    elements,
    scannedAt: new Date().toISOString(),
  };
}
