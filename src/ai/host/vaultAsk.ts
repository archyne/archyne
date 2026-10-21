/**
 * The question the host asks — in its own window, never through the page —
 * before a secret from a vault first goes somewhere: which secret, from which
 * vault, to which address, as what. The page chose all four, so the person
 * confirms them where the page cannot answer for them.
 */

export interface VaultAsk {
  /** The secret's name in the vault. */
  secret: string;
  /** The vault's label. */
  vault: string;
  /** The origin the secret will be sent to. */
  destination: string;
  /** Which of the connection's secrets it stands for (`key`, `password`, …). */
  field: string;
}

export interface AskText {
  title: string;
  message: string;
  /** The whole question as one sentence, for a host whose dialog takes only text. */
  detail: string;
  /** The same as label and value, for a host that lays the question out itself. */
  rows: Array<{ label: string; value: string }>;
  note: string;
  allow: string;
  deny: string;
  /** The language it is in, and which way it reads. */
  lang: string;
  dir: "ltr" | "rtl";
}

type Strings = {
  title: string;
  message: string;
  detail: string;
  rows: { secret: string; vault: string; destination: string; field: string };
  note: string;
  allow: string;
  deny: string;
  fields: Record<string, string>;
};

const STRINGS: Record<string, Strings> = {
  en: {
    title: "Archyne",
    message: "Send a secret from a vault?",
    detail:
      "Archyne will read “{secret}” from the vault “{vault}” and send it to {destination} as the {field}. You are asked once; pointing the service elsewhere asks again.",
    rows: { secret: "Secret", vault: "Vault", destination: "Sent to", field: "As" },
    note: "You are asked once; pointing the service elsewhere asks again.",
    allow: "Allow",
    deny: "Don't allow",
    fields: {
      key: "API key",
      password: "password",
      clientSecret: "client secret",
      privateKey: "private key",
      accessKeyId: "access key ID",
      secretAccessKey: "secret access key",
      sessionToken: "session token",
      tlsCert: "client certificate",
      tlsKey: "certificate key",
      tlsPassphrase: "certificate passphrase",
      tlsCa: "trusted CA",
      tlsPfx: "certificate and key (PKCS#12)",
    },
  },
  it: {
    title: "Archyne",
    message: "Inviare un segreto da una cassaforte?",
    detail:
      "Archyne leggerà “{secret}” dalla cassaforte “{vault}” e lo invierà a {destination} come {field}. Te lo chiede una volta sola; se il servizio punta altrove, te lo chiederà di nuovo.",
    rows: { secret: "Segreto", vault: "Cassaforte", destination: "Inviato a", field: "Come" },
    note: "Te lo chiede una volta sola; se il servizio punta altrove, te lo chiederà di nuovo.",
    allow: "Consenti",
    deny: "Non consentire",
    fields: {
      key: "chiave API",
      password: "password",
      clientSecret: "client secret",
      privateKey: "chiave privata",
      accessKeyId: "ID della chiave di accesso",
      secretAccessKey: "chiave di accesso segreta",
      sessionToken: "token di sessione",
      tlsCert: "certificato client",
      tlsKey: "chiave del certificato",
      tlsPassphrase: "passphrase del certificato",
      tlsCa: "CA attendibile",
      tlsPfx: "certificato e chiave (PKCS#12)",
    },
  },
  de: {
    title: "Archyne",
    message: "Ein Geheimnis aus einem Tresor senden?",
    detail:
      "Archyne liest „{secret}“ aus dem Tresor „{vault}“ und sendet es als {field} an {destination}. Sie werden einmal gefragt; zeigt der Dienst woandershin, erneut.",
    rows: { secret: "Geheimnis", vault: "Tresor", destination: "Gesendet an", field: "Als" },
    note: "Sie werden einmal gefragt; zeigt der Dienst woandershin, erneut.",
    allow: "Erlauben",
    deny: "Nicht erlauben",
    fields: {
      key: "API-Schlüssel",
      password: "Passwort",
      clientSecret: "Client-Geheimnis",
      privateKey: "privaten Schlüssel",
      accessKeyId: "Zugriffsschlüssel-ID",
      secretAccessKey: "geheimen Zugriffsschlüssel",
      sessionToken: "Sitzungstoken",
      tlsCert: "Client-Zertifikat",
      tlsKey: "Zertifikatsschlüssel",
      tlsPassphrase: "Zertifikatspassphrase",
      tlsCa: "vertrauenswürdige CA",
      tlsPfx: "Zertifikat und Schlüssel (PKCS#12)",
    },
  },
  es: {
    title: "Archyne",
    message: "¿Enviar un secreto desde un almacén?",
    detail:
      "Archyne leerá «{secret}» del almacén «{vault}» y lo enviará a {destination} como {field}. Se te pregunta una vez; si el servicio apunta a otro sitio, se te volverá a preguntar.",
    rows: { secret: "Secreto", vault: "Almacén", destination: "Enviado a", field: "Como" },
    note: "Se te pregunta una vez; si el servicio apunta a otro sitio, se te volverá a preguntar.",
    allow: "Permitir",
    deny: "No permitir",
    fields: {
      key: "clave de API",
      password: "contraseña",
      clientSecret: "secreto de cliente",
      privateKey: "clave privada",
      accessKeyId: "ID de clave de acceso",
      secretAccessKey: "clave de acceso secreta",
      sessionToken: "token de sesión",
      tlsCert: "certificado de cliente",
      tlsKey: "clave del certificado",
      tlsPassphrase: "frase de contraseña del certificado",
      tlsCa: "CA de confianza",
      tlsPfx: "certificado y clave (PKCS#12)",
    },
  },
  ja: {
    title: "Archyne",
    message: "保管庫のシークレットを送信しますか?",
    detail:
      "Archyne は保管庫「{vault}」から「{secret}」を読み取り、{field}として {destination} に送信します。確認は一度だけです。サービスの接続先を変えると、もう一度確認します。",
    rows: { secret: "シークレット", vault: "保管庫", destination: "送信先", field: "用途" },
    note: "確認は一度だけです。サービスの接続先を変えると、もう一度確認します。",
    allow: "許可",
    deny: "許可しない",
    fields: {
      key: "API キー",
      password: "パスワード",
      clientSecret: "クライアント シークレット",
      privateKey: "秘密鍵",
      accessKeyId: "アクセスキー ID",
      secretAccessKey: "シークレット アクセスキー",
      sessionToken: "セッション トークン",
      tlsCert: "クライアント証明書",
      tlsKey: "証明書の鍵",
      tlsPassphrase: "証明書のパスフレーズ",
      tlsCa: "信頼する CA",
      tlsPfx: "証明書と鍵 (PKCS#12)",
    },
  },
  zh: {
    title: "Archyne",
    message: "要发送保管库中的机密吗？",
    detail:
      "Archyne 将从保管库“{vault}”读取“{secret}”，并作为{field}发送到 {destination}。只会询问一次；若服务改指向其他地址，会再次询问。",
    rows: { secret: "机密", vault: "保管库", destination: "发送到", field: "用作" },
    note: "只会询问一次；若服务改指向其他地址，会再次询问。",
    allow: "允许",
    deny: "不允许",
    fields: {
      key: "API 密钥",
      password: "密码",
      clientSecret: "客户端密钥",
      privateKey: "私钥",
      accessKeyId: "访问密钥 ID",
      secretAccessKey: "秘密访问密钥",
      sessionToken: "会话令牌",
      tlsCert: "客户端证书",
      tlsKey: "证书密钥",
      tlsPassphrase: "证书密码",
      tlsCa: "受信任的 CA",
      tlsPfx: "证书和密钥（PKCS#12）",
    },
  },
  ar: {
    title: "Archyne",
    message: "هل تريد إرسال سرّ من خزنة؟",
    detail:
      "سيقرأ Archyne ‏«{secret}» من الخزنة «{vault}» ويرسله إلى {destination} بصفته {field}. يُطلب منك ذلك مرة واحدة؛ وإذا وُجِّهت الخدمة إلى عنوان آخر فسيُطلب منك مجددًا.",
    rows: { secret: "السرّ", vault: "الخزنة", destination: "يُرسل إلى", field: "بصفته" },
    note: "يُطلب منك ذلك مرة واحدة؛ وإذا وُجِّهت الخدمة إلى عنوان آخر فسيُطلب منك مجددًا.",
    allow: "سماح",
    deny: "عدم السماح",
    fields: {
      key: "مفتاح API",
      password: "كلمة المرور",
      clientSecret: "سرّ العميل",
      privateKey: "المفتاح الخاص",
      accessKeyId: "معرّف مفتاح الوصول",
      secretAccessKey: "مفتاح الوصول السري",
      sessionToken: "رمز الجلسة",
      tlsCert: "شهادة العميل",
      tlsKey: "مفتاح الشهادة",
      tlsPassphrase: "عبارة مرور الشهادة",
      tlsCa: "جهة التصديق الموثوقة",
      tlsPfx: "الشهادة والمفتاح (PKCS#12)",
    },
  },
};

function language(locale: string): string {
  const base = locale.toLowerCase().split(/[-_]/)[0];
  return base in STRINGS ? base : "en";
}

function strings(locale: string): Strings {
  return STRINGS[language(locale)];
}

/** What a secret field is called, in the language closest to `locale`. */
export function fieldName(locale: string, field: string): string {
  return strings(locale).fields[field] ?? field;
}

/** The question in the language closest to `locale` (`it-IT` → it), English otherwise. */
export function askText(locale: string, ask: VaultAsk): AskText {
  const s = strings(locale);
  const field = s.fields[ask.field] ?? ask.field;
  const detail = s.detail
    .replace("{secret}", ask.secret)
    .replace("{vault}", ask.vault)
    .replace("{destination}", ask.destination)
    .replace("{field}", field);
  const lang = language(locale);
  return {
    title: s.title,
    message: s.message,
    detail,
    rows: [
      { label: s.rows.secret, value: ask.secret },
      { label: s.rows.vault, value: ask.vault },
      { label: s.rows.destination, value: ask.destination },
      // A field named mid-sentence is in lower case; on its own, it starts a line.
      { label: s.rows.field, value: field.charAt(0).toLocaleUpperCase(lang) + field.slice(1) },
    ],
    note: s.note,
    allow: s.allow,
    deny: s.deny,
    lang,
    dir: lang === "ar" ? "rtl" : "ltr",
  };
}
