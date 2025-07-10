import { colord, extend } from 'colord'
import type { Plugin } from 'colord'
import a11yPlugin from 'colord/plugins/a11y'

type LightsOutOptions = {
  verbose?: boolean
  /**
   * The root element of the page where dark mode should be applied.
   * It is recommended to use `document.body` for better performance.
   * (although document.documentElement is also supported).
   */
  pageRoot?: HTMLElement
  /* The default alpha value for the page root background color. */
  pageRootAlpha?: number
  /* A CSSStyleSheet to use for the dark mode styles. */
  cssStyleSheet?: CSSStyleSheet
  /**
   * An array of selectors to filter out from dark mode.
   * This is useful for excluding elements that should not be darkened.
   */
  filterSelectors?: string[]
  /* MutationObserver attribute filter. `style` not supported. */
  attributeFilter?: string[]
  preserveHoverBorderColor?: boolean
}
class LightsOut {
  #isEnabled = false
  #sheet = new CSSStyleSheet()
  #elements = new Set<HTMLElement>()
  #observers = new Map<Element, MutationObserver>()
  #shadowRoots = new Set<ShadowRoot>()
  #shadowSheets = new Set<CSSStyleSheet>()
  #hoverColorRules = new Map<string, CSSRule>()
  #htmlFilterSet: Set<string> = new Set([])
  #pageRoot = document.body
  #pageRootAlpha = 1
  #pageObserver = new MutationObserver(() => {
    this.#update(this.#pageRoot)
  })
  #preserveHoverBorderColor = false
  #backgroundColor = ''
  #markStart = 'lightsOut:start'
  #markEnd = 'lightsOut:end'
  #verbose = false
  #selector = ''
  #cssRules = ''
  #colorValueRgx = /rgba?\([\d,.\s]*\)|hsla?\([\d,.\s]*\)|#[A-Fa-f0-9]{3,8}/g
  #mutationObserverOptions: MutationObserverInit = {
    childList: true,
    subtree: true,
  }

  static defaultCssRules = `
    ::-webkit-scrollbar {
      background-color: #333;
    }
    ::-webkit-scrollbar-thumb {
      background-color: #555;
    }
    ::-webkit-scrollbar-track {
      background-color: #333;
    }
    ::-webkit-scrollbar-corner {
      background-color: #333;
    }
    ::-webkit-scrollbar-button {
      background-color: #333;
    }
    ::-webkit-scrollbar-thumb:hover {
      background-color: #777;
    }
    ::-webkit-scrollbar-thumb:active {
      background-color: #999;
    }
    ::-webkit-scrollbar-track:hover {
      background-color: #444;
    }
    ::-webkit-scrollbar-track:active {
      background-color: #555;
    }
    ::-webkit-scrollbar-button:hover {
      background-color: #444;
    }
    ::-webkit-scrollbar-button:active {
      background-color: #555;
    }
    ::-webkit-scrollbar-corner:hover {
      background-color: #444;
    }
    ::-webkit-scrollbar-corner:active {
      background-color: #555;
    }
    * {
      scrollbar-color: #333 #555 !important;
    }
    input[type="checkbox"], input[type="radio"] {
      filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(20%);
    }
    input[type="checkbox"]:checked,
    input[type="radio"]:checked {
      filter: none !important;
    }
    img[src$=".png"], img[src$=".svg"] {
      filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(70%);
    }
  `
  static defaultFilterSelectors = [
    'html',
    'head',
    'title',
    'meta',
    'script',
    'style',
    'link',
    'iframe',
    'svg',
    'img',
    'canvas',
    'video',
    'audio',
  ]

  constructor(options: LightsOutOptions = {}) {
    const {
      cssStyleSheet,
      filterSelectors,
      attributeFilter,
      verbose = false,
      pageRoot = this.#pageRoot,
      pageRootAlpha = this.#pageRootAlpha,
      preserveHoverBorderColor = this.#preserveHoverBorderColor,
    } = options

    if (!window) {
      throw new Error('LightsOut requires a window to be initialized.')
    }

    this.#verbose = verbose
    this.#pageRoot = pageRoot
    this.#pageRootAlpha = pageRootAlpha
    this.#preserveHoverBorderColor = preserveHoverBorderColor
    this.#htmlFilterSet = Array.isArray(filterSelectors)
      ? new Set(filterSelectors.map(tag => tag.toLowerCase()))
      : new Set(LightsOut.defaultFilterSelectors)
    this.#selector = Array.from(this.#htmlFilterSet)
      .filter(tag => !tag.startsWith(':'))
      .map(tag => `:not(${tag})`)
      .join('')

    if (cssStyleSheet instanceof CSSStyleSheet) {
      this.#cssRules = Array.from(cssStyleSheet.cssRules)
        .map(rule => rule.cssText)
        .join('\n')
    } else {
      this.#cssRules = LightsOut.defaultCssRules.replace('*', this.#selector)
    }

    if (Array.isArray(attributeFilter)) {
      this.#mutationObserverOptions = {
        ...this.#mutationObserverOptions,
        attributes: true,
        // Ignore style attribute to prevent infinite observing loop.
        attributeFilter: attributeFilter.filter(attr => attr !== 'style'),
      }
    }

    extend([a11yPlugin as unknown as Plugin])
  }

  #log(root: Element) {
    // eslint-disable-next-line no-console
    console.log(
      `${root.tagName} styles updated in `,
      performance.measure('lightsOut:update', this.#markStart, this.#markEnd).duration,
      'ms',
    )
  }

  set pageRoot(root: HTMLElement) {
    if (!(root instanceof HTMLElement)) {
      throw new Error('pageRoot must be an instance of HTMLElement')
    }

    this.#pageRoot = root
    if (this.#isEnabled) {
      this.#pageObserver.disconnect()
      this.#pageObserver.observe(this.#pageRoot, this.#mutationObserverOptions)
    }
  }

  get backgroundColor() {
    return this.#backgroundColor
  }

  #traverse(node: Node) {
    if (node instanceof HTMLElement) {
      this.#elements.add(node)

      if (node.shadowRoot) {
        if (!this.#observers.has(node.shadowRoot.host)) {
          const observer = new MutationObserver(() => {
            requestAnimationFrame(() => {
              if (node.shadowRoot) {
                this.#update(node.shadowRoot.host)
              }
            })
          })
          observer.observe(node.shadowRoot, this.#mutationObserverOptions)
          this.#observers.set(node.shadowRoot.host, observer)
        }

        this.#shadowRoots.add(node.shadowRoot)
        ;[...node.shadowRoot.styleSheets]
          .filter(sheet => {
            return !sheet.href || sheet.href.startsWith(window.location.origin)
          })
          .forEach(sheet => {
            this.#shadowSheets.add(sheet)
          })
        node.shadowRoot.querySelectorAll('*').forEach(el => {
          this.#traverse(el)
        })
      }
    }
  }

  #getHoverBorderColorRules() {
    ;[...document.styleSheets, ...this.#shadowSheets]
      .filter(sheet => {
        return !sheet.href || sheet.href.startsWith(window.location.origin)
      })
      .flatMap(sheet => {
        return [...sheet.cssRules]
          .filter(rule => {
            return rule instanceof CSSStyleRule || rule instanceof CSSMediaRule
          })
          .flatMap(rule => {
            if (rule instanceof CSSStyleRule) {
              return rule
            }

            return [...rule.cssRules].filter(r => r instanceof CSSStyleRule)
          })
          .filter(rule => {
            return /:hover/.test(rule.selectorText) && /border/.test(rule.cssText)
          })
      })
      .forEach(rule => {
        this.#hoverColorRules.set(rule.selectorText, rule)
      })
  }

  #walk(root: Element) {
    if (root instanceof HTMLElement) {
      this.#elements.add(root)
    }

    ;(root.shadowRoot || root).querySelectorAll('*').forEach(el => {
      this.#traverse(el)
    })

    if (this.#preserveHoverBorderColor) {
      this.#getHoverBorderColorRules()
    }
  }

  #darken(el: HTMLElement) {
    const computedStyle = getComputedStyle(el)
    const bgColor = computedStyle.backgroundColor
    const bgColord = colord(bgColor)
    const tagName = el.tagName.toLowerCase()
    let darkBgColor = bgColor

    if (!Array.from(this.#htmlFilterSet).some(selector => el.matches(selector))) {
      if (tagName === this.#pageRoot.tagName.toLowerCase()) {
        // Ensure the page root has a non-transparent background color.
        darkBgColor = bgColord.darken(0.9).alpha(this.#pageRootAlpha).toHex()

        if (!this.#backgroundColor) {
          this.#backgroundColor = darkBgColor
        }
      } else if (!bgColord.isDark()) {
        darkBgColor = bgColord.darken(0.9).toHex()
      }

      const borderColorAlpha = colord(computedStyle.borderColor).alpha()
      let colored = colord(computedStyle.color)
      let readable = colored.isReadable(darkBgColor)
      let readableAttempts = 0

      while (!readable && readableAttempts < 10) {
        colored = colored.lighten(0.05)
        readable = colored.isReadable(darkBgColor, { level: 'AAA' })
        readableAttempts++
      }

      if (el.dataset.lightsOut !== 'true') {
        const originalColor = el.style.color
        const originalBgColor = el.style.backgroundColor

        if (originalColor) {
          el.dataset.originalColor = originalColor
        }

        if (originalBgColor) {
          el.dataset.originalBgColor = originalBgColor
        }

        if (borderColorAlpha > 0) {
          const hoverRule = Array.from(this.#hoverColorRules.entries()).find(
            ([selector]) => {
              return el.matches(selector.replace(/:hover/g, ''))
            },
          )

          if (!hoverRule) {
            if (el.style.borderColor) {
              el.dataset.originalBorderColor = el.style.borderColor
            }
            el.style.setProperty('border-color', colored.darken(0.45).toHex())
          }
        }

        if (
          computedStyle.backgroundImage !== 'none' &&
          /-gradient\(/.test(computedStyle.backgroundImage)
        ) {
          const bgImg = computedStyle.backgroundImage.replaceAll(
            this.#colorValueRgx,
            match => {
              const color = colord(match)
              return color.isDark()
                ? color.lighten(0.7).toHex()
                : color.darken(0.7).toHex()
            },
          )

          if (el.style.backgroundImage) {
            el.dataset.originalBgImage = el.style.backgroundImage
          }

          el.style.setProperty('background-image', bgImg)
          el.dataset.lightsOutGradient = 'true'
        }

        el.style.setProperty('color', colored.toHex())
        el.style.setProperty('background-color', darkBgColor)
        el.dataset.lightsOut = 'true'
      }
    }
  }

  #undarken(el: HTMLElement) {
    if (el.dataset.lightsOut === 'true') {
      delete el.dataset.lightsOut

      if (el.dataset.originalColor) {
        el.style.setProperty('color', el.dataset.originalColor)
        delete el.dataset.originalColor
      } else {
        el.style.removeProperty('color')
      }

      if (el.dataset.originalBgColor) {
        el.style.setProperty('background-color', el.dataset.originalBgColor)
        delete el.dataset.originalBgColor
      } else {
        el.style.removeProperty('background-color')
      }

      if (el.dataset.originalBorderColor) {
        el.style.setProperty('border-color', el.dataset.originalBorderColor)
        delete el.dataset.originalBorderColor
      } else {
        el.style.removeProperty('border-color')
      }

      if (el.dataset.lightsOutGradient) {
        delete el.dataset.lightsOutGradient

        if (el.dataset.originalBgImage) {
          el.style.setProperty('background-image', el.dataset.originalBgImage)
          delete el.dataset.originalBgImage
        } else {
          el.style.removeProperty('background-image')
        }
      }
    }
  }

  /**
   * Prevent memory leaks by clearing all elements, shadow roots, and observers.
   * This is called when the dark mode is reset or when the page is updated.
   * It also disconnects any observers that are no longer connected to the DOM.
   */
  #clear() {
    this.#elements.clear()
    this.#shadowRoots.clear()
    this.#shadowSheets.clear()
    this.#hoverColorRules.clear()
    this.#observers.forEach((observer, element) => {
      if (!element.isConnected) {
        observer.disconnect()
        this.#observers.delete(element)
      }
    })
  }

  #update(root: Element) {
    performance.mark(this.#markStart)
    this.#clear()
    this.#walk(root)
    this.#elements.forEach(this.#darken.bind(this))
    this.#shadowRoots.forEach(shadowRoot => {
      shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, this.#sheet]
    })
    performance.mark(this.#markEnd)

    if (this.#verbose) {
      this.#log(root)
    }
  }

  enable() {
    this.#isEnabled = true
    this.#pageObserver.observe(this.#pageRoot, this.#mutationObserverOptions)
    this.#sheet.replaceSync(this.#cssRules)
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.#sheet]
    this.#update(this.#pageRoot)
  }

  disable() {
    this.#isEnabled = false
    this.#walk(this.#pageRoot)
    this.#sheet.replaceSync('')
    this.#backgroundColor = ''
    this.#elements.forEach(this.#undarken.bind(this))
    this.#pageObserver.disconnect()
    this.#observers.forEach((observer, element) => {
      observer.disconnect()
      this.#observers.delete(element)
    })
    this.#clear()
  }

  toggle(force?: boolean) {
    if (force === undefined) {
      force = !this.#isEnabled
    }

    if (force) {
      this.enable()
    } else {
      this.disable()
    }
  }
}

export { LightsOut }
