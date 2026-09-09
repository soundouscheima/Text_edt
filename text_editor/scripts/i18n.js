/* ============================================================
   i18n.js — English/Arabic UI dictionary + RTL/LTR switching.

   Every user-facing string in the app goes through t('key').
   No hardcoded UI strings anywhere else in the codebase.
   Switching locale:
     - re-renders all [data-i18n] elements,
     - sets document.documentElement dir + lang,
     - so the entire chrome (toolbar order, scrollbars, panel
       slide-in side) mirrors correctly via rtl.css.
   The DOCUMENT content direction is independent of the UI
   language (handled per-line by the renderer).
   ============================================================ */

const en = {
  /* generic */
  appName: 'Text Editor',
  save: 'Save',
  saved: 'All changes saved',
  saving: 'Saving…',
  saveFailed: 'Save failed — storage full?',
  saveOffline: 'Offline',
  close: 'Close',
  cancel: 'Cancel',
  confirm: 'Confirm',
  delete: 'Delete',
  ok: 'OK',
  settings: 'Settings',
  preview: 'Preview',
  outline: 'Outline',
  undo: 'Undo',
  redo: 'Redo',
  yes: 'Yes',
  no: 'No',
  back: 'Back',

  /* toolbar tooltips */
  new: 'New document (Ctrl+N)',
  open: 'Open file… (Ctrl+O)',
  export: 'Export / download (Ctrl+S)',
  undoShort: 'Undo (Ctrl+Z)',
  redoShort: 'Redo (Ctrl+Y)',
  zoomIn: 'Zoom in (Ctrl=)',
  zoomOut: 'Zoom out (Ctrl-)',
  wrapOn: 'Word wrap: ON',
  wrapOff: 'Word wrap: OFF',
  findReplace: 'Find / Replace (Ctrl+F)',
  outlineTip: 'Document outline',
  previewTip: 'Markdown preview (Ctrl+Shift+M)',
  focusMode: 'Focus mode (F11)',
  shortcuts: 'Shortcuts (Ctrl+/)',
  aiAssistant: 'AI Assistant (Ctrl+K)',
  aiSettings: 'AI settings',
  uiEnglish: 'Use English UI',
  uiArabic: 'Use Arabic UI (العربية)',
  send: 'Send',

  /* tab bar */
  untitled: 'Untitled',
  newDocTitle: 'New document',
  closeTab: 'Close',

  /* status bar */
  words: 'words',
  chars: 'chars',
  linesStatus: 'lines',
  ltr: 'LTR',
  rtl: 'RTL',
  readingTime: 'read',

  /* find & replace */
  find: 'Find',
  findPlaceholder: 'Find',
  replacePlaceholder: 'Replace',
  replaceAll: 'Replace all',
  replace: 'Replace',
  matchCase: 'Match case',
  wholeWord: 'Whole word',
  regex: 'Regex',
  noResults: 'No results',
  resultsCount: '{n} results',
  prevMatch: 'Previous',
  nextMatch: 'Next',
  closeFind: 'Close find',

  /* modal */
  shortcutsTitle: 'Keyboard Shortcuts',
  downloadTitle: 'Export document',
  exportAsTxt: 'Download as .txt',
  exportAsMd: 'Download as .md',
  openTitle: 'Open file',
  openBtn: 'Choose a file…',
  importHint: 'The file content opens as a new document.',
  confirmTitle: 'Please confirm',
  closeTabConfirm: 'Close document “{name}”? Unsaved changes are kept (saved automatically).',
  restoreVersionTitle: 'Earlier versions of “{name}”',
  restore: 'Restore',
  restoreConfirm: 'Restore the version from {time}? Current content will be replaced.',
  versions: 'versions',
  recentTitle: 'Recent documents',
  statisticsTitle: 'Document statistics',
  topWords: 'Most used words',
  charDist: 'Character distribution',

  /* AI panel */
  aiTitle: 'AI Assistant',
  aiPlaceholder: 'Ask about your document…',
  aiEmptyTitle: 'Connect an AI provider to enable the assistant',
  aiEmptyBody: 'The AI assistant can rewrite, continue, summarize, translate and answer questions about your document. You need an API key that stays in your browser.',
  aiOpenSettings: 'Configure AI provider',
  aiSettingsTitle: 'AI Provider Settings',
  aiProvider: 'Provider',
  aiApiKey: 'API key',
  aiModel: 'Model',
  aiBaseUrl: 'Custom base URL (optional)',
  aiShow: 'Show',
  aiHide: 'Hide',
  aiKeyDisclaimer: 'Your API key is stored only in your browser (localStorage), in plain text, and is sent directly to the AI provider only when you send a message. It is never sent to this site or anywhere else.',
  aiKeyStored: 'Key saved locally.',
  aiTest: 'Test connection',
  aiTesting: 'Testing…',
  aiTestOk: 'Connection OK ✓',
  aiTestFail: 'Connection failed: {err}',
  aiClearChat: 'Clear chat',
  aiClearChatTitle: 'Clear chat conversation?',
  aiNoKey: 'No API key configured. Enter one in settings.',
  aiThinking: 'Thinking…',
  aiStreamErr: 'Could not load model output.',
  aiErrInvalidKey: 'Invalid API key or unauthorized (401). Check your key.',
  aiErrQuota: 'Quota exceeded or rate limited (429). Try again later.',
  aiErrModel: 'Model not found. Check the model name.',
  aiErrNotFound: 'Model or endpoint not found (404).',
  aiErrServer: 'Provider error (5xx). Try again.',
  aiErrNetwork: 'Network error — are you offline? Check your connection.',
  aiErrProvider: 'Unknown provider: {p}',
  aiErrUnknown: 'Unexpected error: {err}',
  aiOfflineTitle: 'You are offline',
  aiOfflineBody: 'The editor keeps working perfectly, but the AI assistant needs an internet connection.',
  aiOfflineBody2: 'When you are back online, retry your message.',
  aiInsert: 'Insert at cursor',
  aiReplaceSel: 'Replace selection',
  aiInserted: 'Inserted ✓',
  aiCopy: 'Copy',
  aiCopied: 'Copied ✓',

  /* AI quick actions */
  qaGrammar: 'Fix grammar',
  qaRewrite: 'Rewrite this paragraph',
  qaContinue: 'Continue writing',
  qaSummarize: 'Summarize',
  qaTranslateAr: 'Translate to Arabic',
  qaTranslateEn: 'Translate to English',
  qaFormal: 'Make formal',
  qaCasual: 'Make casual',
  qaExplain: 'Explain this text',

  /* onboarding tour */
  tour1Title: 'Welcome to the bilingual editor',
  tour1Body: 'A fast, from-scratch text editor that works fully offline. Everything you type is saved automatically in your browser.',
  tour2Title: 'Tabs',
  tour2Body: 'Each tab is a separate document with its own history. Add one with the “New” button (Ctrl+N).',
  tour3Title: 'AI Assistant',
  tour3Body: 'Open the AI assistant with Ctrl+K — it can rewrite, continue, summarize or translate your text. Connect a provider once in settings.',
  tour4Title: 'Language',
  tour4Body: 'Switch the interface between English and Arabic here. Documents can mix both languages at once.',
  tour5Title: 'Keyboard shortcuts',
  tour5Body: 'Press Ctrl+/ to see every shortcut, translated into your language.',
  tourSkip: 'Skip tour',
  tourNext: 'Next',
  tourDone: 'Get started',
  tourStep: 'Step {a} of {b}',

  /* focus mode */
  exitFocus: 'Click or press Esc to exit focus mode',
  focusHint: 'Focus mode',

  /* toasts */
  toastImported: 'Opened “{name}”',
  toastExported: 'Exported “{name}”',
  toastNoFile: 'No file chosen.',
  toastKeyMissing: 'Set an API key first (settings).',
  toastCantPaste: 'Cannot access clipboard. Try Ctrl+V.',
  toastCopied: 'Copied {n} chars',
  toastRestoredVersion: 'Restored version from {time}',
  toastVersionRestored: 'Version restored.',
  toastStorageLow: 'Storage nearly full: old versions will be pruned.',
  toastQuota: 'Could not save — storage full. Export your documents and delete some.',
  toastClearRecents: 'Recent documents cleared.',
  toastLangReset: 'Selected language: {l}',

  /* settings modal */
  settingsTitle: 'Settings',
  stTheme: 'Theme',
  stLight: 'Light',
  stDark: 'Dark',
  stFontSize: 'Editor font size',
  stFontFamily: 'Editor font',
  stWrap: 'Word wrap',
  stLineNumbers: 'Line numbers',
  stViewDistance: 'focus mode',
  stUILanguage: 'Interface language',
  stTextDirection: 'Default text direction',
  stDirAuto: 'Auto (per paragraph)',
  stDirLtr: 'Force left-to-right',
  stDirRtl: 'Force right-to-left',
  stLineHeight: 'Line spacing',

  /* menu/exit */
  focusExitHint: 'Focus mode — press Esc to exit',
  selectAll: ' Select all (Ctrl+A)',
  dragHint: 'Drop a .txt or .md file to open it',
  dragTitle: 'Drop file to open',

  /* misc */
  lineCol: 'Ln {l}, Col {c}',
  readingTimeLabel: '{t} min read',
  clearHistory: 'Clear',
  version: 'Version',
  justNow: 'just now',
  minutesAgo: '{m} min ago',
  hoursAgo: '{h} h ago',
  daysAgo: '{d} d ago',
  aiChatTitle: 'Chat',

  /* persistence */
  restoreSession: 'Session restored',
  bootRestore: 'Restoring your session…',
  emptyHint: 'Start typing. Everything is saved automatically.',
  firstWords: 'Write your first document, or open a file and paste it here.',

  /* misc */
  focusExitTitle: 'Focus mode',
  focusExitBtn: 'Exit focus'
};

const ar = {
  backendName: 'محرر النصوص',
  appName: 'محرر النصوص',
  save: 'حفظ',
  saved: 'تم حفظ جميع التغييرات',
  saving: 'جارٍ الحفظ…',
  saveFailed: 'فشل الحفظ — هل المساحة ممتلئة؟',
  saveOffline: 'غير متصل',
  close: 'إغلاق',
  cancel: 'إلغاء',
  confirm: 'تأكيد',
  delete: 'حذف',
  ok: 'حسناً',
  settings: 'الإعدادات',
  preview: 'معاينة',
  outline: 'المخطط',
  undo: 'تراجع',
  redo: 'إعادة',
  yes: 'نعم',
  no: 'لا',
  back: 'رجوع',

  new: 'مستند جديد (Ctrl+N)',
  open: 'فتح ملف… (Ctrl+O)',
  export: 'تصدير / تنزيل (Ctrl+S)',
  undoShort: 'تراجع (Ctrl+Z)',
  redoShort: 'إعادة (Ctrl+Y)',
  zoomIn: 'تكبير (Ctrl=)',
  zoomOut: 'تصغير (Ctrl-)',
  wrapOn: 'التفاف النص: مفعّل',
  wrapOff: 'التفاف النص: معطّل',
  findReplace: 'بحث واستبدال (Ctrl+F)',
  outlineTip: 'مخطط المستند',
  previewTip: 'معاينة ماركداون (Ctrl+Shift+M)',
  focusMode: 'وضع التركيز (F11)',
  shortcuts: 'الاختصارات (Ctrl+/)',
  aiAssistant: 'المساعد الذكي (Ctrl+K)',
  aiSettings: 'إعدادات الذكاء الاصطناعي',
  uiEnglish: 'استخدام واجهة إنجليزية',
  uiArabic: 'استخدام الواجهة العربية',
  send: 'إرسال',

  untitled: 'بدون عنوان',
  newDocTitle: 'مستند جديد',
  closeTab: 'إغلاق',

  words: 'كلمات',
  chars: 'حروف',
  linesStatus: 'أسطر',
  ltr: 'LTR',
  rtl: 'RTL',
  readingTime: 'قراءة',

  find: 'بحث',
  findPlaceholder: 'بحث',
  replacePlaceholder: 'استبدال',
  replaceAll: 'استبدال الكل',
  replace: 'استبدال',
  matchCase: 'مطابقة حالة الأحرف',
  wholeWord: 'كلمة كاملة',
  regex: 'تعبير نمطي',
  noResults: 'لا توجد نتائج',
  resultsCount: '{n} نتائج',
  prevMatch: 'السابق',
  nextMatch: 'التالي',
  closeFind: 'إغلاق البحث',

  shortcutsTitle: 'اختصارات لوحة المفاتيح',
  downloadTitle: 'تصدير المستند',
  exportAsTxt: 'تنزيل كملف .txt',
  exportAsMd: 'تنزيل كملف .md',
  openTitle: 'فتح ملف',
  openBtn: 'اختر ملفاً…',
  importHint: 'سيُفتح محتوى الملف كمستند جديد.',
  confirmTitle: 'تأكيد',
  closeTabConfirm: 'إغلاق مستند “{name}”؟ سيتم الاحتفاظ بالتغييرات (محفوظة تلقائياً).',
  restoreVersionTitle: 'نسخ سابقة من “{name}”',
  restore: 'استعادة',
  restoreConfirm: 'استعادة نسخة {time}؟ سيتم استبدال المحتوى الحالي.',
  versions: 'نسخ',
  recentTitle: 'المستندات الأخيرة',
  statisticsTitle: 'إحصائيات المستند',
  topWords: 'الكلمات الأكثر استخداماً',
  charDist: 'توزيع الحروف',

  aiTitle: 'المساعد الذكي',
  aiPlaceholder: 'اسأل عن مستندك…',
  aiEmptyTitle: 'اربط مزود ذكاء اصطناعي لتفعيل المساعد',
  aiEmptyBody: 'يمكن للمساعد إعادة الكتابة والمتابعة والتلخيص والترجمة والإجابة عن أسئلة حول مستندك. تحتاج مفتاح API يبقى في متصفحك.',
  aiOpenSettings: 'إعداد المزود',
  aiSettingsTitle: 'إعدادات مزود الذكاء الاصطناعي',
  aiProvider: 'المزود',
  aiApiKey: 'مفتاح API',
  aiModel: 'النموذج',
  aiBaseUrl: 'رابط أساسي مخصص (اختياري)',
  aiShow: 'إظهار',
  aiHide: 'إخفاء',
  aiKeyDisclaimer: 'يُخزَّن مفتاح API الخاص بك في متصفحك فقط (localStorage) كنص عادي، ويُرسل مباشرة إلى مزود الذكاء الاصطناعي فقط عند إرسال رسالة. لا يُرسَل أبداً إلى هذا الموقع أو أي مكان آخر.',
  aiKeyStored: 'تم حفظ المفتاح محلياً.',
  aiTest: 'اختبار الاتصال',
  aiTesting: 'جارٍ الاختبار…',
  aiTestOk: 'الاتصال ناجح ✓',
  aiTestFail: 'فشل الاتصال: {err}',
  aiClearChat: 'مسح المحادثة',
  aiClearChatTitle: 'مسح محادثة المساعد؟',
  aiNoKey: 'لا يوجد مفتاح API مضبوط. أدخله في الإعدادات.',
  aiThinking: 'جارٍ التفكير…',
  aiStreamErr: 'تعذّر تحميل مخرجات النموذج.',
  aiErrInvalidKey: 'مفتاح API غير صحيح أو غير مصرّح (401). تحقق من المفتاح.',
  aiErrQuota: 'تم تجاوز الحصة أو تقييد المعدل (429). حاول لاحقاً.',
  aiErrModel: 'النموذج غير موجود. تحقق من اسم النموذج.',
  aiErrNotFound: 'النموذج أو الرابط غير موجود (404).',
  aiErrServer: 'خطأ من المزود (5xx). حاول مجدداً.',
  aiErrNetwork: 'خطأ في الشبكة — هل أنت غير متصل؟ تحقق من الاتصال.',
  aiErrProvider: 'مزود غير معروف: {p}',
  aiErrUnknown: 'خطأ غير متوقع: {err}',
  aiOfflineTitle: 'أنت غير متصل',
  aiOfflineBody: 'المحرر يعمل بشكل كامل، لكن المساعد الذكي يحتاج اتصالاً بالإنترنت.',
  aiOfflineBody2: 'عند عودتك إلى الإنترنت أعد إرسال رسالتك.',
  aiInsert: 'إدراج عند المؤشر',
  aiReplaceSel: 'استبدال التحديد',
  aiInserted: 'تم الإدراج ✓',
  aiCopy: 'نسخ',
  aiCopied: 'تم النسخ ✓',

  qaGrammar: 'تصحيح القواعد',
  qaRewrite: 'إعادة كتابة الفقرة',
  qaContinue: 'مواصلة الكتابة',
  qaSummarize: 'تلخيص',
  qaTranslateAr: 'ترجمة إلى العربية',
  qaTranslateEn: 'ترجمة إلى الإنجليزية',
  qaFormal: 'أسلوب رسمي',
  qaCasual: 'أسلوب عفوي',
  qaExplain: 'شرح النص',

  tour1Title: 'مرحباً بك في المحرر ثنائي اللغة',
  tour1Body: 'محرر نص سريع ومبني من الصفر يعمل دون اتصال. كل ما تكتبه يُحفظ تلقائياً في متصفحك.',
  tour2Title: 'التبويبات',
  tour2Body: 'كل تبويب مستند مستقل له تاريخه الخاص. أضف واحداً بزر “جديد” (Ctrl+N).',
  tour3Title: 'المساعد الذكي',
  tour3Body: 'افتح المساعد بزر Ctrl+K — يعيد الكتابة أو يواصل أو يلخّص أو يترجم النص. اربط مزوداً مرة واحدة في الإعدادات.',
  tour4Title: 'اللغة',
  tour4Body: 'بدّل واجهة الاستخدام بين الإنجليزية والعربية هنا. ويمكن أن تتضمن المستندات اللغتين معاً.',
  tour5Title: 'اختصارات لوحة المفاتيح',
  tour5Body: 'اضغط Ctrl+/ لعرض كل الاختصارات مترجمة إلى لغتك.',
  tourSkip: 'تخطي الجولة',
  tourNext: 'التالي',
  tourDone: 'ابدأ الآن',
  tourStep: 'الخطوة {a} من {b}',

  exitFocus: 'انقر أو اضغط Esc للخروج من وضع التركيز',
  focusHint: 'وضع التركيز',

  toastImported: 'تم فتح “{name}”',
  toastExported: 'تم تصدير “{name}”',
  toastNoFile: 'لم يتم اختيار ملف.',
  toastKeyMissing: 'عيِّن مفتاح API أولاً (الإعدادات).',
  toastCantPaste: 'لا يمكن الوصول إلى الحافظة. جرّب Ctrl+V.',
  toastCopied: 'تم نسخ {n} حرفاً',
  toastRestoredVersion: 'تمت استعادة نسخة {time}',
  toastVersionRestored: 'تمت الاستعادة.',
  toastStorageLow: 'المساحة شبه ممتلئة: سيتم اقتطاع النسخ القديمة.',
  toastQuota: 'تعذّر الحفظ — المساحة ممتلئة. صدّر مستنداتك واحذف بعضها.',
  toastClearRecents: 'تم مسح المستندات الأخيرة.',
  toastLangReset: 'اللغة المختارة: {l}',

  settingsTitle: 'الإعدادات',
  stTheme: 'المظهر',
  stLight: 'فاتح',
  stDark: 'داكن',
  stFontSize: 'حجم خط المحرر',
  stFontFamily: 'خط المحرر',
  stWrap: 'التفاف النص',
  stLineNumbers: 'أرقام الأسطر',
  stViewDistance: 'وضع التركيز',
  stUILanguage: 'لغة الواجهة',
  stTextDirection: 'اتجاه النص الافتراضي',
  stDirAuto: 'تلقائي (حسب الفقرة)',
  stDirLtr: 'من اليسار لليمين',
  stDirRtl: 'من اليمين لليسار',
  stLineHeight: 'تباعد الأسطر',

  focusExitHint: 'وضع التركيز — اضغط Esc للخروج',
  selectAll: 'تحديد الكل (Ctrl+A)',
  dragHint: 'أفلت ملف .txt أو .md هنا لفتحه',
  dragTitle: 'أفلت الملف لفتحه',

  lineCol: 'سطر {l}، عمود {c}',
  readingTimeLabel: '{t} دقيقة قراءة',
  clearHistory: 'مسح',
  version: 'نسخة',
  justNow: 'الآن',
  minutesAgo: 'منذ {m} دقيقة',
  hoursAgo: 'منذ {h} ساعة',
  daysAgo: 'منذ {d} يوم',
  aiChatTitle: 'محادثة',

  restoreSession: 'تمت استعادة الجلسة',
  bootRestore: 'جارٍ استعادة جلستك…',
  emptyHint: 'ابدأ الكتابة. كل شيء يُحفظ تلقائياً.',
  firstWords: 'اكتب مستندك الأول، أو افتح ملفاً والصقه هنا.',

  focusExitTitle: 'وضع التركيز',
  focusExitBtn: 'الخروج من وضع التركيز'
};

const dicts = { en, ar };

let current = 'en';
let countF = null; // formatter for plural, unused placeholder

let listeners = [];

class I18n {
  constructor() { this.locale = 'en'; }

  t(key, vars = {}) {
    const d = dicts[this.locale] || dicts.en;
    let s = d[key] ?? dicts.en[key] ?? key;
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return s;
  }

  setLocale(loc) {
    if (!dicts[loc]) loc = 'en';
    this.locale = loc;
    document.documentElement.lang = loc;
    document.documentElement.dir = loc === 'ar' ? 'rtl' : 'ltr';
    document.body.classList.toggle('lang-ar', loc === 'ar');
    localStorage.setItem('te.lang', loc);
    for (const fn of listeners) fn(loc);
  }

  getLocale() { return this.locale; }

  onChanged(fn) { listeners.push(fn); }

  /** Translate all [data-i18n] elements + tooltips + placeholders. */
  applyDom(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      el.textContent = this.t(k);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = this.t(el.getAttribute('data-i18n-title'));
      el.setAttribute('aria-label', this.t(el.getAttribute('data-i18n-title')));
    });
    // data-tip tooltips (already rendered by CSS ::after using attr)
    root.querySelectorAll('[data-tip]').forEach(el => {
      el.setAttribute('data-tip', this.t(el.getAttribute('data-tip')));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.setAttribute('placeholder', this.t(el.getAttribute('data-i18n-placeholder')));
    });
  }
}

export const i18n = new I18n();
export default i18n;