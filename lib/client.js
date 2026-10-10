/**
 * dsh-sticker-mode — browser half.
 *
 * 只做两件事：
 *   1. 在输入框右侧渲染一个开关（位置与样式对齐 jev 的那个绿色开关）；
 *   2. **上报 location.origin** —— Host 侧靠它生成「客户端可达」的图片地址。
 *
 * 第 2 件事看着不起眼，但它是这个插件能工作的前提：DSH 的 Web 服务默认监听 0.0.0.0，
 * 浏览器可能在另一台设备上，而服务端自己猜网卡在多网卡机器上会猜错 ——
 * 浏览器永远知道自己的 origin 是什么。
 *
 * 状态真相在 Host（~/.dsh/sticker-mode.json），不是 localStorage —— 因为
 * Agent 必须能读到它，而 localStorage 只存在于某一台浏览器、某一个 origin 下。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sticker-mode',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    var STATE_URL = '/sticker-mode/state';
    var CLIENT_URL = '/sticker-mode/client';
    var POLL_MS = 10000;
    var STYLE_ID = 'dsh-sticker-mode-styles';

    // 开关几何照抄 jev：32x18 轨道 + 14px 白色滑块 + translateX(14px)。
    // 绿色优先用宿主 token，拿不到再退回静态绿。
    var CSS = [
      '.dsm-wrap{display:inline-flex;align-items:center;gap:6px;user-select:none}',
      '.dsm-label{font-size:12px;line-height:18px;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsm-switch{position:relative;flex:none;width:32px;height:18px;padding:0;border:0;',
      'border-radius:999px;cursor:pointer;transition:background-color .15s ease;',
      'background:var(--dsw-alias-fill-l3,rgb(0 0 0 / 20%))}',
      '.dsm-switch:disabled{opacity:.5;cursor:default}',
      '.dsm-switch[data-state="checked"]{',
      'background:var(--dsw-alias-state-success-primary,var(--dsw-static-green-500,#22c55e))}',
      '.dsm-switch[data-state="unknown"]{background:var(--dsw-alias-fill-l2,rgb(0 0 0 / 12%))}',
      '.dsm-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;',
      'background:#fff;box-shadow:0 1px 2px rgb(0 0 0 / 20%);transition:transform .15s ease}',
      '.dsm-switch[data-state="checked"] .dsm-knob{transform:translateX(14px)}',
      '.dsm-page{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:20px}',
      '.dsm-row{display:flex;align-items:center;gap:8px}',
      '.dsm-kv{font-family:var(--ds-font-family-code,Consolas,monospace);font-size:12px;',
      'word-break:break-all;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsm-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.dsm-preview{max-width:180px;max-height:180px;border-radius:8px;',
      'background:var(--dsw-alias-bg-base,#fff)}',
      '.dsm-pre{white-space:pre-wrap;word-break:break-all;font-family:',
      'var(--ds-font-family-code,Consolas,monospace);font-size:12px;margin:0;',
      'color:var(--dsw-alias-label-secondary,#61666b)}',

      // ---- 表情包尺寸上限 ----
      // DSH 渲染 Markdown 图片的样式只限宽不限高：
      //   ._image_xxx{display:block;width:auto;max-width:100%;height:auto;...}
      // 于是一张方图在大窗口里会按容器宽度撑开，几乎占满整个对话高度。
      // 这里按 src 精确匹配本插件的图片（不影响其它图片），并留成 CSS 变量便于调：
      //   document.documentElement.style.setProperty('--dsm-sticker-max-height','160px')
      // 选择器 img[...] 的特异度(0,1,1)高于渲染器的单个类名(0,1,0)，无需 !important 也能覆盖，
      // 但仍写上以防将来渲染器改成内联样式。
      'img[src*="/sticker-mode/"]:not(.dsm-preview){',
      'max-height:var(--dsm-sticker-max-height,200px)!important;',
      'max-width:var(--dsm-sticker-max-width,260px)!important;',
      'width:auto!important;height:auto!important;object-fit:contain}',
      // 不做悬停放大：尺寸恒定，避免鼠标划过时布局跳动（用户明确不要）。
    ].join('');

    /** 幂等地把样式塞进 <head>，返回清理函数（交给 ctx.effect）。 */
    function injectCss() {
      var existing = document.getElementById(STYLE_ID);
      if (existing) return function () {};
      var el = document.createElement('style');
      el.id = STYLE_ID;
      el.setAttribute('data-plugin', 'dsh-sticker-mode');
      el.textContent = CSS;
      document.head.appendChild(el);
      return function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      };
    }

    function readState() {
      return fetch(STATE_URL, { headers: { Accept: 'application/json' }, cache: 'no-store' }).then(
        function (r) {
          return r.json();
        },
      );
    }

    function writeState(enabled) {
      return fetch(STATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabled }),
        cache: 'no-store',
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }

    /**
     * 上报本浏览器的 origin，Host 用它拼客户端可达的图片 URL。
     * 必须带上 sessionId：Host 按**会话**记地址，多网段下不同客户端
     * 才能各自拿到自己可达的主机前缀（只存一个全局值会让另一网段破图）。
     */
    function reportOrigin(sessionId) {
      try {
        return fetch(CLIENT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ origin: window.location.origin, sessionId: sessionId || null }),
          cache: 'no-store',
        }).catch(function () {});
      } catch (_ignored) {
        return Promise.resolve();
      }
    }

    /** 从槽位 owner props 里取会话 id（字段形态随版本有差异，多重兜底）。 */
    function sessionIdOf(props) {
      if (!props) return null;
      return props.sessionId || (props.session && props.session.id) || props.id || null;
    }

    /**
     * 把消息里 `/sticker-mode/` 图片的主机前缀改写成**当前浏览器的 origin**。
     *
     * 为什么必须这么做：图片地址是在工具调用那一刻写进消息文本的，之后不会变。
     * 换设备（或换访问地址，例如 localhost ↔ 局域网 IP）打开同一条消息时，
     * 里面烙的可能是当时那个地址，于是图全破。
     * 消息本身改不动（assistant 消息一旦提交就不可改写），但渲染出来的 <img>
     * 在浏览器这边是可以就地纠正的 —— 只改前缀，路径原样保留。
     */
    function rewriteStickerImageHosts() {
      var origin = window.location.origin;
      var imgs;
      try {
        imgs = document.querySelectorAll('img[src*="/sticker-mode/"]');
      } catch (_ignored) {
        return;
      }
      for (var i = 0; i < imgs.length; i++) {
        try {
          var u = new URL(imgs[i].getAttribute('src'), origin);
          if (u.origin === origin) continue;
          if (u.pathname.indexOf('/sticker-mode/') !== 0) continue;
          imgs[i].setAttribute('src', origin + u.pathname + u.search);
        } catch (_ignored) {}
      }
    }

    /** 共享的状态订阅：轮询 Host，10 秒一次（对齐 jev 的做法）。 */
    function useStickerState(sessionId) {
      var ref = React.useState({ known: false, enabled: false, pending: false });
      var state = ref[0];
      var setState = ref[1];

      var load = React.useCallback(function () {
        readState()
          .then(function (json) {
            setState(function (s) {
              return {
                known: true,
                enabled: json && json.gate ? json.gate.enabled === true : false,
                pending: s.pending,
              };
            });
          })
          .catch(function () {});
      }, []);

      React.useEffect(
        function () {
          load();
          reportOrigin(sessionId);
          var timer = setInterval(load, POLL_MS);
          // 页面重新可见时重报一次：切网段 / 换地址后能尽快纠正
          var onVisible = function () {
            if (document.visibilityState === 'visible') reportOrigin(sessionId);
          };
          document.addEventListener('visibilitychange', onVisible);
          return function () {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
          };
        },
        [load, sessionId],
      );

      var toggle = React.useCallback(
        function () {
          var next = !state.enabled;
          setState(function (s) {
            return { known: true, enabled: next, pending: true };
          });
          writeState(next)
            .then(function (json) {
              setState(function () {
                return {
                  known: true,
                  enabled: json && json.gate ? json.gate.enabled === true : next,
                  pending: false,
                };
              });
            })
            .catch(function () {
              setState(function (s) {
                return { known: s.known, enabled: s.enabled, pending: false };
              });
              load();
            });
        },
        [state.enabled, load],
      );

      return { state: state, toggle: toggle, reload: load };
    }

    /** 输入框右侧的那个开关。 */
    function StickerToggleButton(props) {
      var s = useStickerState(sessionIdOf(props));
      var st = !s.state.known ? 'unknown' : s.state.enabled ? 'checked' : 'unchecked';
      return h(
        'span',
        { className: 'dsm-wrap', title: '表情包模式：开启后 AI 每次回复末尾会附一张表情包' },
        h('span', { className: 'dsm-label' }, '表情'),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'data-state': st,
            'aria-checked': s.state.known ? s.state.enabled : 'mixed',
            'aria-label': '表情包模式开关',
            className: 'dsm-switch',
            disabled: s.state.pending || !s.state.known,
            onClick: s.toggle,
          },
          h('span', { className: 'dsm-knob' }),
        ),
      );
    }

    /** 设置页里的一块：开关 + 排障信息（尤其图片地址前缀对不对）。 */
    function StickerSettingsPage() {
      var s = useStickerState();
      var infoRef = React.useState(null);
      var info = infoRef[0];
      var setInfo = infoRef[1];

      React.useEffect(
        function () {
          readState()
            .then(setInfo)
            .catch(function () {});
        },
        [s.state.enabled],
      );

      var st = !s.state.known ? 'unknown' : s.state.enabled ? 'checked' : 'unchecked';
      var sample = info && info.origin ? info.origin + '/sticker-mode/img/bmiddle/005XSXmNgy1gsv82m8gkrj309q09iaaf.jpg' : '';

      return h(
        'div',
        { className: 'dsm-page' },
        h(
          'div',
          { className: 'dsm-row' },
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'data-state': st,
              'aria-checked': s.state.known ? s.state.enabled : 'mixed',
              'aria-label': '表情包模式开关',
              className: 'dsm-switch',
              disabled: s.state.pending || !s.state.known,
              onClick: s.toggle,
            },
            h('span', { className: 'dsm-knob' }),
          ),
          h('span', null, s.state.enabled ? '已开启：AI 每次回复末尾会附一张表情包' : '已关闭'),
        ),
        h(
          'div',
          { className: 'dsm-hint' },
          '开启后 Host 会在每一步系统提示里注入一条指令，AI 便会用 sticker_pick 工具搜一张相关的图放在回复末尾。',
        ),
        h('div', { className: 'dsm-kv' }, '图片地址前缀：' + (info && info.origin ? info.origin : '(读取中…)')),
        h(
          'div',
          { className: 'dsm-kv' },
          'origin 来源：' + (info ? (info.originSource === 'client' ? '浏览器上报' : '服务端兜底（刷新页面即可上报）') : '…'),
        ),
        info && info.gate && info.gate.changedAt
          ? h('div', { className: 'dsm-kv' }, '上次变更：' + info.gate.changedAt + '（' + (info.gate.changedBy || '?') + '）')
          : null,
        h('div', { className: 'dsm-hint' }, '状态存在 Host 的 ~/.dsh/sticker-mode.json，Agent 直接读得到。'),
        h('div', { className: 'dsm-hint' }, '控制台可用：__dshStickerMode.state() / .on() / .off() / .probe()'),
        sample ? h('img', { className: 'dsm-preview', src: sample, alt: '地址自检图' }) : null,
        sample ? h('div', { className: 'dsm-hint' }, '上面这张图若能显示，说明图片地址前缀正确。') : null,
      );
    }

    function apply(ctx) {
      ctx.effect(function () {
        return injectCss();
      }, 'sticker-mode: styles');

      // 就地把跨网段的历史图片地址改写成本浏览器的 origin（详见函数注释）
      ctx.effect(
        function () {
          var timer = null;
          var observer = null;
          var schedule = function () {
            if (timer) return;
            timer = setTimeout(function () {
              timer = null;
              rewriteStickerImageHosts();
            }, 150);
          };
          schedule();
          try {
            observer = new MutationObserver(schedule);
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['src'],
            });
          } catch (_ignored) {}
          return function () {
            if (observer) observer.disconnect();
            if (timer) clearTimeout(timer);
          };
        },
        'sticker-mode: image host rewrite',
      );

      if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('conversation.input.right', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'sticker-mode-toggle',
              order: 9,
              label: function () {
                return '表情包模式开关';
              },
            },
            StickerToggleButton,
          );
        });

        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'sticker-mode',
              order: 26,
              label: function () {
                return '表情包模式';
              },
            },
            StickerSettingsPage,
          );
        });
      }

      // 控制台排障 API
      try {
        window.__dshStickerMode = {
          state: readState,
          on: function () {
            return writeState(true);
          },
          off: function () {
            return writeState(false);
          },
          probe: function () {
            return readState().then(function (json) {
              var url = json.origin + '/sticker-mode/img/bmiddle/005XSXmNgy1gsv82m8gkrj309q09iaaf.jpg';
              return new Promise(function (resolve) {
                var img = new Image();
                img.onload = function () {
                  resolve({ ok: true, url: url, origin: json.origin });
                };
                img.onerror = function () {
                  resolve({ ok: false, url: url, origin: json.origin });
                };
                img.src = url;
              });
            });
          },
        };
      } catch (_ignored) {}

      ctx.effect(function () {
        return function () {
          try {
            delete window.__dshStickerMode;
          } catch (_ignored) {}
        };
      }, 'sticker-mode: console api');
    }

    exports.name = 'sticker-mode';
    /** Cordis 服务门禁：只要 slots 就能活。 */
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
