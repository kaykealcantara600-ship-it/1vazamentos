require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { startWeb } = require('./web');
const {
  Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits, ChannelType,
  SlashCommandBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, FileBuilder,
} = require('discord.js');

/* ============================ CONFIG BÁSICA ============================ */
const BRAND = '1 Vazamentos';
const COLOR = 0x5865f2, OK = 0x57f287, RED = 0xed4245, WARN = 0xfee75c;
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;

// Site de downloads (sincronizado com o bot)
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const STORAGE_DIR = path.join(__dirname, 'storage');
fs.mkdirSync(STORAGE_DIR, { recursive: true });
const MAX_FILE_BYTES = (Number(process.env.MAX_FILE_MB) || 200) * 1024 * 1024;

// Valores fixos (usados se ainda não foram definidos pelo /painel)
const DEFAULTS = {
  canal_pedidos: '1560822113462521927', // pedidos de bot
  cargo_staff: '1496757100930666596',   // seu cargo (único mencionado nos carrinhos/tickets)
};

/* ============================ BANCO (JSON) ============================ */
const DB_PATH = path.join(__dirname, 'data.json');
let db = { config: {}, requests: {}, tickets: {}, sources: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
for (const [k, v] of Object.entries(DEFAULTS)) if (!db.config[k]) db.config[k] = v;
save();

/* ============================ HELPERS DE UI ============================ */
const text = (s) => new TextDisplayBuilder().setContent(s);
const sep = (big = false) => new SeparatorBuilder().setDivider(true)
  .setSpacing(big ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (id, label, style = ButtonStyle.Secondary, emoji) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
};
function box(color, ...items) {
  const c = new ContainerBuilder().setAccentColor(color);
  for (const x of items.flat()) {
    if (!x) continue;
    if (x instanceof TextDisplayBuilder) c.addTextDisplayComponents(x);
    else if (x instanceof SeparatorBuilder) c.addSeparatorComponents(x);
    else if (x instanceof ActionRowBuilder) c.addActionRowComponents(x);
    else if (x instanceof FileBuilder) c.addFileComponents(x);
  }
  return c;
}
const deny = (i, msg) => i.reply({ flags: V2 | EPH, components: [box(RED, text(`❌ ${msg}`))] });
const isStaff = (m) => !!m && (
  m.permissions.has(PermissionFlagsBits.Administrator) ||
  (db.config.cargo_staff && m.roles.cache.has(db.config.cargo_staff))
);
function modal(id, title, fields) {
  return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(
    fields.map((f) => {
      const t = new TextInputBuilder().setCustomId(f.id).setLabel(f.label)
        .setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(f.required !== false).setMaxLength(f.max || 800);
      if (f.ph) t.setPlaceholder(f.ph);
      return row(t);
    })
  );
}

const MODALS = {
  bot: () => modal('m:bot', 'Pedir um bot', [
    { id: 'desc', label: 'Descrição do bot', long: true, max: 900 },
    { id: 'faz', label: 'O que ele faz?', long: true, max: 900 },
    { id: 'mais', label: 'O que mais você quer? (opcional)', long: true, required: false, max: 900 },
  ]),
  sug: () => modal('m:sug', 'Sugestão para o servidor', [
    { id: 'sug', label: 'O que devemos melhorar ou aprimorar?', long: true, max: 1500 },
  ]),
  cargo: () => modal('m:cargo', 'Cargo próprio', [
    { id: 'nome', label: 'Nome do cargo', max: 50 },
    { id: 'cor', label: 'Cor em HEX', max: 7, ph: '#ff0066' },
  ]),
};

/* ============================ PAINEL DE CONFIG (/painel) ============================ */
const LABELS = {
  canal_pedidos: 'Canal de pedidos de bot', canal_sugestoes: 'Canal de sugestões',
  canal_cargos: 'Canal de pedidos de cargo', canal_sources: 'Canal de sources',
  canal_logs: 'Canal de logs (tickets/carrinhos)', categoria_tickets: 'Categoria dos tickets e carrinhos',
  cargo_staff: 'Cargo da staff (o único mencionado)', cargo_vip: 'Cargo VIP',
};

function configPanel() {
  const c = db.config;
  const ch = (k) => (c[k] ? `<#${c[k]}>` : '`não definido`');
  const ro = (k) => (c[k] ? `<@&${c[k]}>` : '`não definido`');
  return box(COLOR,
    text(`# ${BRAND}\n-# Painel de configuração`), sep(),
    text(
      `**Canais**\n` +
      `🤖 Pedidos de bot: ${ch('canal_pedidos')}\n💡 Sugestões: ${ch('canal_sugestoes')}\n` +
      `🎨 Pedidos de cargo: ${ch('canal_cargos')} *(se vazio, usa o de pedidos de bot)*\n` +
      `📦 Sources: ${ch('canal_sources')}\n📜 Logs: ${ch('canal_logs')}\n🎫 Categoria de tickets/carrinhos: ${ch('categoria_tickets')}\n\n` +
      `**Cargos**\n🛡️ Staff: ${ro('cargo_staff')}\n💎 VIP: ${ro('cargo_vip')}`
    ), sep(),
    row(
      btn('cfg:canal_pedidos', 'Pedidos', ButtonStyle.Secondary, '🤖'),
      btn('cfg:canal_sugestoes', 'Sugestões', ButtonStyle.Secondary, '💡'),
      btn('cfg:canal_cargos', 'Cargos', ButtonStyle.Secondary, '🎨'),
      btn('cfg:canal_sources', 'Sources', ButtonStyle.Secondary, '📦'),
      btn('cfg:canal_logs', 'Logs', ButtonStyle.Secondary, '📜'),
    ),
    row(
      btn('cfg:categoria_tickets', 'Categoria', ButtonStyle.Secondary, '🎫'),
      btn('cfg:cargo_staff', 'Cargo staff', ButtonStyle.Secondary, '🛡️'),
      btn('cfg:cargo_vip', 'Cargo VIP', ButtonStyle.Secondary, '💎'),
    ), sep(),
    row(
      btn('src:novo', 'Lançar source', ButtonStyle.Success, '🚀'),
      btn('painel:publicar', 'Publicar painel aqui', ButtonStyle.Primary, '📌'),
    ),
    text(`-# Créditos: ${BRAND}`)
  );
}

/* ============================ PAINEL PÚBLICO (MENU DE SELEÇÃO) ============================ */
function publicPanel() {
  const menu = new StringSelectMenuBuilder().setCustomId('panel:menu').setPlaceholder('Selecione uma opção...')
    .addOptions(
      { label: 'Pedir bot', value: 'bot', description: 'Peça um bot para a administração', emoji: '🤖' },
      { label: 'Sugestão', value: 'sug', description: 'Diga o que podemos melhorar no servidor', emoji: '💡' },
      { label: 'Cargo próprio', value: 'cargo', description: 'Cargo personalizado (precisa de aprovação)', emoji: '🎨' },
      { label: 'Comprar VIP', value: 'vip', description: 'Abre um carrinho para finalizar a compra', emoji: '💎' },
      { label: 'Abrir ticket', value: 'ticket', description: 'Atendimento privado com a staff', emoji: '🎫' },
    );
  return box(COLOR,
    text(`# ${BRAND}`),
    text('Bem-vindo(a)! Escolha uma opção no menu abaixo.'), sep(),
    text(
      '🤖 **Pedir bot** — peça um bot para a administração\n' +
      '💡 **Sugestão** — diga o que podemos melhorar no servidor\n' +
      '🎨 **Cargo próprio** — peça um cargo personalizado\n' +
      '💎 **Comprar VIP** — abra um carrinho e finalize a compra\n' +
      '🎫 **Ticket** — atendimento privado com a staff'
    ), sep(),
    row(menu),
    text(`-# Créditos: ${BRAND}`)
  );
}

/* ============================ PEDIDOS (bot / cargo) ============================ */
const KIND = {
  bot: { title: '🤖 Pedido de bot', ch: 'canal_pedidos' },
  cargo: { title: '🎨 Pedido de cargo próprio', ch: 'canal_cargos' },
};

function requestCard(id) {
  const r = db.requests[id];
  const done = r.status !== 'pendente';
  const status = !done ? '⏳ Pendente'
    : r.status === 'aprovado' ? `✅ Aprovado por <@${r.by}>` : `❌ Recusado por <@${r.by}>`;
  return box(done ? (r.status === 'aprovado' ? OK : RED) : COLOR,
    text(`# ${KIND[r.kind].title}\n-# ${BRAND}`), sep(),
    text(`**Solicitante:** <@${r.user}>\n\n` + r.fields.map(([k, v]) => `**${k}**\n${v}`).join('\n\n')), sep(),
    text(`**Status:** ${status}`),
    !done && row(btn(`rq:ok:${id}`, 'Aprovar', ButtonStyle.Success, '✅'), btn(`rq:no:${id}`, 'Recusar', ButtonStyle.Danger, '❌'))
  );
}

async function sendRequest(i, kind, fields, data = {}) {
  const chId = db.config[KIND[kind].ch] || (kind === 'cargo' ? db.config.canal_pedidos : null);
  const ch = chId && (await i.guild.channels.fetch(chId).catch(() => null));
  if (!ch) return deny(i, 'Esse recurso ainda não foi configurado. Avise a administração.');
  const id = Date.now().toString(36) + Math.floor(Math.random() * 99);
  db.requests[id] = { kind, user: i.user.id, fields, data, status: 'pendente' };
  save();
  await ch.send({ flags: V2, components: [requestCard(id)], allowedMentions: { parse: [] } });
  return i.reply({
    flags: V2 | EPH,
    components: [box(OK, text(kind === 'cargo'
      ? '✅ Pedido enviado! Os administradores precisam aprovar e você será avisado(a) por DM.'
      : '✅ Pedido enviado para a administração! Você será avisado(a) por DM.'))],
  });
}

/* ============================ SUGESTÕES ============================ */
function sugCard(id) {
  const r = db.requests[id];
  const v = Object.values(r.votes || {});
  const up = v.filter((x) => x === 1).length, down = v.filter((x) => x === -1).length;
  return box(COLOR,
    text(`# 💡 Sugestão\n-# ${BRAND}`), sep(),
    text(`**De:** <@${r.user}>\n\n${r.fields[0][1]}`), sep(),
    row(btn(`sug:up:${id}`, String(up), ButtonStyle.Success, '👍'), btn(`sug:down:${id}`, String(down), ButtonStyle.Danger, '👎'))
  );
}

/* ============================ SOURCES ============================ */
async function storeFile(att, id) {
  if (att.size > MAX_FILE_BYTES) throw new Error(`arquivo maior que o limite de ${Math.round(MAX_FILE_BYTES / 1048576)} MB`);
  const safe = att.name.replace(/[^\w.\-]/g, '_');
  const stored = `${id}_${safe}`;
  const res = await fetch(att.url);
  if (!res.ok || !res.body) throw new Error('não consegui baixar o arquivo do Discord');
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(path.join(STORAGE_DIR, stored)));
  return { name: att.name, stored, size: att.size };
}

async function publishSource(guild, user, { nome, desc, cat, link, file }) {
  const ch = db.config.canal_sources && (await guild.channels.fetch(db.config.canal_sources).catch(() => null));
  if (!ch) throw new Error('canal de sources não configurado');
  const id = crypto.randomBytes(5).toString('hex');
  const rec = {
    id, nome, desc, cat: cat || 'Outros', link: link || null, file: null,
    by: { id: user.id, tag: user.username }, at: Date.now(), downloads: 0,
  };

  let att = null, fb = null;
  if (file) {
    if (PUBLIC_URL) {
      rec.file = await storeFile(file, id); // hospedado no site
    } else {
      const safe = file.name.replace(/[^\w.\-]/g, '_'); // sem site: anexa direto no Discord
      att = new AttachmentBuilder(file.url, { name: safe });
      fb = new FileBuilder().setURL(`attachment://${safe}`);
    }
  }

  const buttons = [];
  if (rec.file) buttons.push(new ButtonBuilder().setLabel('Baixar').setStyle(ButtonStyle.Link).setURL(`${PUBLIC_URL}/download/${id}`).setEmoji('⬇️'));
  if (link) buttons.push(new ButtonBuilder().setLabel('Baixar').setStyle(ButtonStyle.Link).setURL(link).setEmoji('⬇️'));
  if (PUBLIC_URL && (rec.file || link)) buttons.push(new ButtonBuilder().setLabel('Ver no site').setStyle(ButtonStyle.Link).setURL(`${PUBLIC_URL}/#${id}`).setEmoji('🌐'));
  buttons.push(btn(`srcdel:${id}`, 'Remover', ButtonStyle.Danger, '🗑️'));

  const info = [`**Categoria:** ${rec.cat}`];
  if (rec.file) info.push(`**Tamanho:** ${(rec.file.size / 1048576).toFixed(1)} MB`);

  const card = box(COLOR,
    text(`# 📦 ${nome}\n-# ${BRAND}`), sep(),
    text(desc), sep(),
    text(info.join('  •  ')),
    fb,
    row(...buttons),
    text(`-# Créditos: ${BRAND} • Lançado por <@${user.id}>`)
  );

  let msg;
  try {
    msg = await ch.send({ flags: V2, components: [card], files: att ? [att] : [], allowedMentions: { parse: [] } });
  } catch (e) {
    if (rec.file) fs.rm(path.join(STORAGE_DIR, rec.file.stored), { force: true }, () => {});
    throw e;
  }
  rec.msg = { channel: ch.id, id: msg.id };
  db.sources[id] = rec; save();
  web.broadcast('new', id);
  return msg;
}

/* ============================ TICKETS E CARRINHOS ============================ */
const CATS = {
  suporte: 'Suporte', bot: 'Pedido de bot', vip: 'Dúvida VIP / Pagamento',
  parceria: 'Parceria', denuncia: 'Denúncia', outro: 'Outro', carrinho: 'Carrinho VIP',
};

// "IA" local sem API: palavras-chave -> resposta automática (1x por assunto por ticket)
const FAQ = [
  ['vip', /vip|premium|assinatura|assinar/, '💎 Para comprar o VIP, selecione **Comprar VIP** no painel que abrimos um carrinho para você.'],
  ['pagamento', /pix|pagamento|pago|comprovante|paguei/, '💳 Envie o **comprovante** (print) e o seu @ aqui no ticket. A staff confere e libera o quanto antes.'],
  ['bot', /\bbot\b|comando|discord bot/, '🤖 Para pedir um bot, descreva: **o que ele deve fazer**, comandos desejados e referências. Você também pode usar **Pedir bot** no painel.'],
  ['cargo', /cargo|cor\b|personalizad/, '🎨 Para cargo próprio, diga o **nome** e a **cor em HEX** (ex.: `#ff0066`). Ou use **Cargo próprio** no painel.'],
  ['source', /source|download|baixar|link|quebrad|off\b|erro/, '📦 Informe o **nome da source** e o que está acontecendo (link quebrado, arquivo com erro, etc.) para a staff verificar.'],
  ['parceria', /parceria|divulg|parceiro/, '🤝 Para parcerias, envie o **link do seu servidor**, quantidade de membros e o que propõe.'],
  ['denuncia', /denunci|golpe|ofens|ameaç|spam/, '🚨 Para denúncias, mande **prints/provas** e o @ ou ID do usuário. A staff vai analisar com prioridade.'],
];

const staffPing = () => (db.config.cargo_staff ? `<@&${db.config.cargo_staff}>` : 'A staff');

function ticketCard(chId) {
  const t = db.tickets[chId];
  return box(COLOR,
    text(`# 🎫 Ticket — ${CATS[t.cat]}\n-# ${BRAND}`), sep(),
    text(`Olá <@${t.user}>! Explique seu caso com o máximo de detalhes. ${staffPing()} já foi avisada.\n\n**Responsável:** ${t.claimedBy ? `<@${t.claimedBy}>` : 'ninguém ainda'}`), sep(),
    row(btn('tk:claim', 'Assumir', ButtonStyle.Success, '🙋'), btn('tk:close', 'Fechar', ButtonStyle.Danger, '🔒'))
  );
}

function cartCard(chId) {
  const t = db.tickets[chId];
  return box(OK,
    text(`# 🛒 Carrinho — VIP\n-# ${BRAND}`), sep(),
    text(`Olá <@${t.user}>! ${staffPing()} vai te atender aqui para finalizar a compra do **VIP**. Aguarde um momento.`), sep(),
    row(btn('cart:liberar', 'Liberar VIP', ButtonStyle.Success, '💎'), btn('tk:close', 'Fechar carrinho', ButtonStyle.Danger, '🔒'))
  );
}

// Cria o canal privado (ticket ou carrinho). Só menciona o cargo da staff e quem abriu.
async function makeChannel(i, cat, cart) {
  const existing = Object.entries(db.tickets).find(
    ([id, t]) => t.user === i.user.id && !!t.cart === cart && i.guild.channels.cache.has(id)
  );
  if (existing) return { existing: existing[0] };

  const P = PermissionFlagsBits;
  const overwrites = [
    { id: i.guild.id, deny: [P.ViewChannel] },
    { id: i.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] },
    { id: i.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
  ];
  if (db.config.cargo_staff) {
    overwrites.push({ id: db.config.cargo_staff, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] });
  }
  const ch = await i.guild.channels.create({
    name: `${cart ? 'carrinho' : 'ticket'}-${i.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: db.config.categoria_tickets || null,
    permissionOverwrites: overwrites,
  });
  db.tickets[ch.id] = { user: i.user.id, cat, cart, claimedBy: null, createdAt: Date.now(), staffReplied: false, reminded: false, answered: [] };
  save();
  await ch.send({
    flags: V2,
    components: [cart ? cartCard(ch.id) : ticketCard(ch.id)],
    allowedMentions: { users: [i.user.id], roles: db.config.cargo_staff ? [db.config.cargo_staff] : [] },
  });
  return { ch };
}

async function createTicket(i) {
  await i.deferUpdate();
  const r = await makeChannel(i, i.values[0], false);
  if (r.existing) return i.editReply({ components: [box(WARN, text(`⚠️ Você já tem um ticket aberto: <#${r.existing}>`))] });
  return i.editReply({ components: [box(OK, text(`✅ Ticket criado: ${r.ch}`))] });
}

async function openCart(i) {
  await i.reply({ flags: V2 | EPH, components: [box(COLOR, text('⏳ Criando seu carrinho...'))] });
  const r = await makeChannel(i, 'carrinho', true);
  if (r.existing) return i.editReply({ components: [box(WARN, text(`⚠️ Você já tem um carrinho aberto: <#${r.existing}>`))] });
  return i.editReply({ components: [box(OK, text(`🛒 Carrinho criado: ${r.ch}\nA staff vai te atender por lá.`))] });
}

function openTicketMenu(i) {
  const menu = new StringSelectMenuBuilder().setCustomId('tk:cat').setPlaceholder('Sobre o que é o ticket?')
    .addOptions(Object.entries(CATS).filter(([k]) => k !== 'carrinho').map(([v, l]) => ({ label: l, value: v })));
  return i.reply({ flags: V2 | EPH, components: [box(COLOR, text('🎫 **Escolha o assunto do ticket:**'), row(menu))] });
}

// Roteia a opção escolhida no menu do painel
async function openOption(i, v) {
  if (MODALS[v]) return i.showModal(MODALS[v]());
  if (v === 'vip') return openCart(i);
  if (v === 'ticket') return openTicketMenu(i);
}

async function buildTranscript(ch) {
  let all = [], last;
  while (all.length < 2000) {
    const batch = await ch.messages.fetch({ limit: 100, before: last });
    if (!batch.size) break;
    all.push(...batch.values());
    last = batch.last().id;
  }
  return all.reverse().map((m) => {
    const body = m.content || (m.components?.length ? '[painel do bot]' : '');
    const files = m.attachments.size ? ' ' + [...m.attachments.values()].map((a) => a.url).join(' ') : '';
    return `[${m.createdAt.toISOString()}] ${m.author.tag}: ${body}${files}`;
  }).join('\n');
}

/* ============================ CLIENT ============================ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const web = startWeb({
  getDb: () => db, save, client, storageDir: STORAGE_DIR, brand: BRAND,
  port: Number(process.env.PORT) || 3000,
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Online como ${client.user.tag}`);
  client.user.setActivity(`${BRAND} • /painel`);

  // Descrição do bot (aba "Sobre mim") com "1 Vazamentos" no topo
  try {
    const desc = `${BRAND}\n\nBot desenvolvido pela: 1 vazamentos feita para quem deseja pegar source free e para um espaço mais limpo.: ${BRAND}`;
    await client.application.edit({ description: desc.slice(0, 400) });
  } catch (e) { console.warn('Não consegui atualizar a descrição:', e.message); }

  // Registro do /painel
  const cmd = new SlashCommandBuilder().setName('painel').setDescription(`Painel de configuração do ${BRAND}`)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false).toJSON();
  try {
    await client.application.commands.set([cmd], process.env.GUILD_ID || undefined);
    console.log('✅ Comando /painel registrado');
  } catch (e) { console.error('Erro ao registrar comandos:', e); }

  // Lembrete: ticket/carrinho sem resposta da staff em 10 min
  setInterval(() => {
    for (const [id, t] of Object.entries(db.tickets)) {
      if (t.staffReplied || t.reminded || Date.now() - t.createdAt < 10 * 60e3) continue;
      const ch = client.channels.cache.get(id);
      if (!ch) { delete db.tickets[id]; save(); continue; }
      t.reminded = true; save();
      ch.send({
        flags: V2,
        components: [box(WARN, text(`⏰ ${staffPing()}, este ${t.cart ? 'carrinho' : 'ticket'} aguarda atendimento há mais de 10 minutos.`))],
        allowedMentions: { roles: db.config.cargo_staff ? [db.config.cargo_staff] : [] },
      }).catch(() => {});
    }
  }, 60e3);
});

// Ticket inteligente: respostas automáticas por palavra-chave (não vale para carrinhos)
client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || !m.guild) return;
  const t = db.tickets[m.channelId];
  if (!t) return;
  if (isStaff(m.member)) { if (!t.staffReplied) { t.staffReplied = true; save(); } return; }
  if (t.cart) return;
  const txt = m.content.toLowerCase();
  for (const [key, re, answer] of FAQ) {
    if (!t.answered.includes(key) && re.test(txt)) {
      t.answered.push(key); save();
      await m.channel.send({
        flags: V2,
        components: [box(COLOR, text(`🤖 **Resposta automática**\n${answer}`), text('-# Se não resolver, a staff já vai te atender.'))],
        allowedMentions: { parse: [] },
      }).catch(() => {});
      break;
    }
  }
});

/* ============================ INTERAÇÕES ============================ */
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'painel') {
      if (!isStaff(i.member)) return deny(i, 'Apenas a staff pode usar este comando.');
      return i.reply({ flags: V2 | EPH, components: [configPanel()] });
    }
    if (i.isButton()) return await onButton(i);
    if (i.isAnySelectMenu()) return await onSelect(i);
    if (i.isModalSubmit()) return await onModal(i);
  } catch (e) {
    console.error(e);
    const p = { flags: V2 | EPH, components: [box(RED, text('❌ Ocorreu um erro. Verifique as permissões do bot e tente de novo.'))] };
    if (i.replied || i.deferred) i.followUp(p).catch(() => {}); else i.reply(p).catch(() => {});
  }
});

async function onButton(i) {
  const [ns, a, b] = i.customId.split(':');

  if (ns === 'cfg') {
    if (!isStaff(i.member)) return deny(i, 'Apenas a staff.');
    let menu;
    if (a.startsWith('canal_')) {
      menu = new ChannelSelectMenuBuilder().setCustomId(`cfgset:${a}`)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setPlaceholder('Escolha o canal');
    } else if (a.startsWith('categoria_')) {
      menu = new ChannelSelectMenuBuilder().setCustomId(`cfgset:${a}`)
        .setChannelTypes(ChannelType.GuildCategory).setPlaceholder('Escolha a categoria');
    } else {
      menu = new RoleSelectMenuBuilder().setCustomId(`cfgset:${a}`).setPlaceholder('Escolha o cargo');
    }
    return i.reply({ flags: V2 | EPH, components: [box(COLOR, text(`**${LABELS[a]}**\nSelecione abaixo:`), row(menu))] });
  }

  if (ns === 'painel' && a === 'publicar') {
    if (!isStaff(i.member)) return deny(i, 'Apenas a staff.');
    await i.channel.send({ flags: V2, components: [publicPanel()] });
    return i.reply({ flags: V2 | EPH, components: [box(OK, text('✅ Painel publicado neste canal!'))] });
  }

  if (ns === 'src' && a === 'novo') {
    if (!isStaff(i.member)) return deny(i, 'Apenas a staff.');
    return i.showModal(modal('m:src', 'Lançar source', [
      { id: 'nome', label: 'Nome da source', max: 100, ph: 'Ex.: Sistema de loja v2' },
      { id: 'desc', label: 'Descrição', long: true, max: 1500 },
      { id: 'cat', label: 'Categoria (ex.: Bot, Script, Site)', required: false, max: 30, ph: 'Bot' },
      { id: 'link', label: 'Link para baixar (vazio = enviar arquivo)', required: false, max: 400, ph: 'https://...' },
    ]));
  }

  if (ns === 'srcdel') {
    if (!isStaff(i.member)) return deny(i, 'Apenas a staff pode remover sources.');
    const s = db.sources[a];
    if (!s) return deny(i, 'Essa source já foi removida.');
    if (s.file) fs.rm(path.join(STORAGE_DIR, s.file.stored), { force: true }, () => {});
    delete db.sources[a]; save();
    web.broadcast('remove', a);
    return i.update({ components: [box(RED, text(`🗑️ **${s.nome}** foi removida por <@${i.user.id}>.`))], allowedMentions: { parse: [] } });
  }

  // Compatibilidade com painéis antigos (botões)
  if (ns === 'req') return openOption(i, a);

  if (ns === 'rq') {
    if (!isStaff(i.member)) return deny(i, 'Apenas a staff pode decidir pedidos.');
    const r = db.requests[b];
    if (!r || r.status !== 'pendente') return deny(i, 'Esse pedido já foi resolvido.');
    const ok = a === 'ok';
    if (ok && r.kind === 'cargo') {
      const m = await i.guild.members.fetch(r.user).catch(() => null);
      if (m) {
        const role = await i.guild.roles.create({ name: r.data.nome, color: r.data.cor, reason: `Cargo próprio - ${BRAND}` });
        await m.roles.add(role);
      }
    }
    r.status = ok ? 'aprovado' : 'recusado'; r.by = i.user.id; save();
    await i.update({ components: [requestCard(b)], allowedMentions: { parse: [] } });
    const u = await client.users.fetch(r.user).catch(() => null);
    u?.send(`${ok ? '✅' : '❌'} Seu pedido (**${KIND[r.kind].title}**) foi **${r.status}** no ${BRAND}.`).catch(() => {});
    return;
  }

  if (ns === 'sug') {
    const r = db.requests[b];
    if (!r) return deny(i, 'Sugestão não encontrada.');
    r.votes ||= {};
    const v = a === 'up' ? 1 : -1;
    if (r.votes[i.user.id] === v) delete r.votes[i.user.id]; else r.votes[i.user.id] = v;
    save();
    return i.update({ components: [sugCard(b)], allowedMentions: { parse: [] } });
  }

  if (ns === 'cart' && a === 'liberar') {
    if (!isStaff(i.member)) return deny(i, 'Apenas a staff pode liberar o VIP.');
    const t = db.tickets[i.channelId];
    if (!t) return deny(i, 'Este canal não é um carrinho ativo.');
    if (!db.config.cargo_vip) return deny(i, 'Defina o **Cargo VIP** no /painel primeiro.');
    const m = await i.guild.members.fetch(t.user).catch(() => null);
    if (!m) return deny(i, 'Não encontrei o membro no servidor.');
    await m.roles.add(db.config.cargo_vip);
    return i.reply({
      flags: V2,
      components: [box(OK, text(`💎 VIP liberado para <@${t.user}> por <@${i.user.id}>!`))],
      allowedMentions: { users: [t.user] },
    });
  }

  if (ns === 'tk') {
    if (a === 'abrir') return openTicketMenu(i);
    const t = db.tickets[i.channelId];
    if (!t) return deny(i, 'Este canal não é um ticket/carrinho ativo.');
    if (a === 'claim') {
      if (!isStaff(i.member)) return deny(i, 'Apenas a staff pode assumir.');
      t.claimedBy = i.user.id; t.staffReplied = true; save();
      await i.update({ components: [ticketCard(i.channelId)], allowedMentions: { parse: [] } });
      return i.channel.send({ flags: V2, components: [box(OK, text(`🙋 <@${i.user.id}> assumiu este ticket.`))], allowedMentions: { parse: [] } });
    }
    if (a === 'close') {
      if (!isStaff(i.member) && i.user.id !== t.user) return deny(i, 'Sem permissão para fechar.');
      return i.reply({
        flags: V2 | EPH,
        components: [box(WARN, text('🔒 Tem certeza que deseja fechar? O canal será apagado e a transcrição salva nos logs.'),
          row(btn('tk:confirm', 'Confirmar fechamento', ButtonStyle.Danger, '🔒')))],
      });
    }
    if (a === 'confirm') {
      if (!isStaff(i.member) && i.user.id !== t.user) return deny(i, 'Sem permissão para fechar.');
      await i.update({ components: [box(WARN, text('🔒 Fechando em 5 segundos...'))] });
      const logId = db.config.canal_logs;
      const log = logId && (await i.guild.channels.fetch(logId).catch(() => null));
      if (log) {
        const txt = await buildTranscript(i.channel);
        const name = `transcript-${i.channel.name}.txt`;
        await log.send({
          flags: V2,
          components: [box(COLOR,
            text(`# 📜 ${t.cart ? 'Carrinho' : 'Ticket'} fechado\n**Canal:** ${i.channel.name}\n**Dono:** <@${t.user}>\n**Assunto:** ${CATS[t.cat]}\n**Responsável:** ${t.claimedBy ? `<@${t.claimedBy}>` : '—'}\n**Fechado por:** <@${i.user.id}>`),
            new FileBuilder().setURL(`attachment://${name}`),
            text(`-# ${BRAND}`))],
          files: [new AttachmentBuilder(Buffer.from(txt || 'vazio'), { name })],
          allowedMentions: { parse: [] },
        }).catch(console.error);
      }
      delete db.tickets[i.channelId]; save();
      const ch = i.channel;
      setTimeout(() => ch.delete('Fechado').catch(() => {}), 5000);
      return;
    }
  }
}

async function onSelect(i) {
  const [ns, a] = i.customId.split(':');

  // Menu do painel público
  if (ns === 'panel' && a === 'menu') {
    const v = i.values[0];
    await openOption(i, v);
    // Reseta o menu para a opção escolhida não ficar marcada
    i.message.edit({ flags: V2, components: [publicPanel()] }).catch(() => {});
    return;
  }

  if (ns === 'cfgset') {
    if (!isStaff(i.member)) return deny(i, 'Apenas a staff.');
    const v = i.values[0];
    db.config[a] = v; save();
    const mention = a.startsWith('cargo_') ? `<@&${v}>` : `<#${v}>`;
    return i.update({
      components: [box(OK, text(`✅ **${LABELS[a]}** definido para ${mention}\n-# Rode /painel de novo para ver o resumo atualizado.`))],
      allowedMentions: { parse: [] },
    });
  }

  if (ns === 'tk' && a === 'cat') return createTicket(i);
}

async function onModal(i) {
  const f = (k) => i.fields.getTextInputValue(k).trim();

  if (i.customId === 'm:bot') {
    return sendRequest(i, 'bot', [['Descrição do bot', f('desc')], ['O que ele faz', f('faz')], ['Algo mais', f('mais') || '—']]);
  }

  if (i.customId === 'm:sug') {
    const chId = db.config.canal_sugestoes;
    const ch = chId && (await i.guild.channels.fetch(chId).catch(() => null));
    if (!ch) return deny(i, 'Canal de sugestões não configurado.');
    const id = Date.now().toString(36) + Math.floor(Math.random() * 99);
    db.requests[id] = { kind: 'sug', user: i.user.id, fields: [['Sugestão', f('sug')]], votes: {}, status: 'aberta' };
    save();
    await ch.send({ flags: V2, components: [sugCard(id)], allowedMentions: { parse: [] } });
    return i.reply({ flags: V2 | EPH, components: [box(OK, text('✅ Sugestão enviada! Obrigado por ajudar o servidor.'))] });
  }

  if (i.customId === 'm:cargo') {
    const hex = f('cor').replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return deny(i, 'Cor inválida. Use HEX, ex.: `#ff0066`.');
    return sendRequest(i, 'cargo', [['Nome do cargo', f('nome')], ['Cor', `#${hex}`]], { nome: f('nome'), cor: parseInt(hex, 16) });
  }

  if (i.customId === 'm:src') {
    if (!isStaff(i.member)) return deny(i, 'Apenas a staff.');
    const nome = f('nome'), desc = f('desc'), cat = f('cat'), link = f('link');
    if (!db.config.canal_sources) return deny(i, 'Configure o canal de sources no /painel primeiro.');

    if (link) {
      if (!/^https?:\/\//i.test(link)) return deny(i, 'O link precisa começar com http:// ou https://');
      await publishSource(i.guild, i.user, { nome, desc, cat, link });
      return i.reply({ flags: V2 | EPH, components: [box(OK, text('🚀 Source lançada!'))] });
    }

    await i.reply({
      flags: V2 | EPH,
      components: [box(COLOR, text('📎 Envie o **arquivo** aqui neste canal nos próximos **2 minutos**.'))],
    });
    const col = i.channel.createMessageCollector({ filter: (m) => m.author.id === i.user.id, time: 120000, max: 1 });
    col.on('collect', async (m) => {
      const file = m.attachments.first();
      if (!file) {
        return i.followUp({ flags: V2 | EPH, components: [box(WARN, text('Lançamento cancelado (nenhum arquivo enviado).'))] });
      }
      try {
        if (PUBLIC_URL) await i.followUp({ flags: V2 | EPH, components: [box(COLOR, text('⏳ Hospedando o arquivo no site...'))] });
        await publishSource(i.guild, i.user, { nome, desc, cat, file });
        await m.delete().catch(() => {});
        await i.followUp({ flags: V2 | EPH, components: [box(OK, text('🚀 Source lançada com o arquivo!'))] });
      } catch (e) {
        console.error(e);
        await i.followUp({ flags: V2 | EPH, components: [box(RED, text(`❌ Falhou ao publicar: ${e.message}`))] });
      }
    });
    col.on('end', (c, reason) => {
      if (reason === 'time') i.followUp({ flags: V2 | EPH, components: [box(WARN, text('⏰ Tempo esgotado. Clique em **Lançar source** de novo.'))] }).catch(() => {});
    });
  }
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
client.login(process.env.TOKEN);