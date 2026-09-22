const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const SteamUser = require('steam-user');
require('dotenv').config();

process.on('unhandledRejection', (err) => {
    console.error('⚠️ Unhandled promise rejection (bot is staying up):', err);
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught exception (bot is staying up):', err);
});

// Steam/Discord connections occasionally go quietly unresponsive without ever firing an
// 'error' or disconnect event, which no in-process reconnect logic can detect or recover
// from. Instead of trying to detect that, just exit cleanly once an hour and let run.bat
// relaunch a fresh process.
const RESTART_INTERVAL_MS = 60 * 60 * 1000;
setTimeout(() => {
    console.log('🔄 Scheduled hourly restart — exiting so run.bat can relaunch.');
    process.exit(0);
}, RESTART_INTERVAL_MS);

const discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});
const steamClient = new SteamUser({ autoRelogin: true });

// steam-user internally fetches rich-presence localization strings before processing every
// single persona update, through a globally-serialized (concurrency 1) queue. We don't use
// rich_presence_string (we read raw rich_presence tokens directly), and that fetch can fail/
// time out (10s) in this environment, backing up ALL friends' updates behind it. Short-circuit
// it so persona processing never stalls.
steamClient.getAppRichPresenceLocalization = function (appID, language, callback) {
    if (typeof language === 'function') {
        callback = language;
    }
    if (typeof callback === 'function') {
        process.nextTick(() => callback(null, { tokens: {} }));
    }
    return Promise.resolve({ tokens: {} });
};

const TRACKED_FILE = path.join(__dirname, 'trackedFriends.json');

function loadTrackedFriends() {
    if (!fs.existsSync(TRACKED_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(TRACKED_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveTrackedFriends(list) {
    fs.writeFileSync(TRACKED_FILE, JSON.stringify(list, null, 2));
}

let trackedFriends = loadTrackedFriends();

const MESSAGES_FILE = path.join(__dirname, 'trackedMessages.json');

function loadTrackedMessages() {
    if (!fs.existsSync(MESSAGES_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveTrackedMessages(map) {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(map, null, 2));
}

let trackedMessages = loadTrackedMessages();

const OWNERS_FILE = path.join(__dirname, 'trackedOwners.json');

function loadOwners() {
    if (!fs.existsSync(OWNERS_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(OWNERS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveOwners(map) {
    fs.writeFileSync(OWNERS_FILE, JSON.stringify(map, null, 2));
}

let trackedOwners = loadOwners();

const STATE_FILE = path.join(__dirname, 'trackedState.json');

function loadState() {
    if (!fs.existsSync(STATE_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveState(map) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(map, null, 2));
}

let trackedState = loadState();

// Backfill dailyStartBalance for any player who has a balance but no baseline yet
// (first run after adding the daily top-earner feature, or a player added mid-day).
(function initDailyStartBalances() {
    let changed = false;
    for (const state of Object.values(trackedState)) {
        if (typeof state.balance === 'number' && typeof state.dailyStartBalance !== 'number') {
            state.dailyStartBalance = state.balance;
            changed = true;
        }
    }
    if (changed) saveState(trackedState);
})();

const HISTORY_FILE = path.join(__dirname, 'trackedHistory.json');
const MAX_HISTORY_PER_PLAYER = 25;

function loadHistory() {
    if (!fs.existsSync(HISTORY_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveHistory(map) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(map, null, 2));
}

let trackedHistory = loadHistory();

const RICH_PRESENCE_KEYS_FILE = path.join(__dirname, 'trackedRichPresenceKeys.json');
const MAX_SAMPLE_VALUES_PER_KEY = 5;

function loadRichPresenceKeys() {
    if (!fs.existsSync(RICH_PRESENCE_KEYS_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(RICH_PRESENCE_KEYS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveRichPresenceKeys(map) {
    fs.writeFileSync(RICH_PRESENCE_KEYS_FILE, JSON.stringify(map, null, 2));
}

let knownRichPresenceKeys = loadRichPresenceKeys();

function recordRichPresenceKeys(rp) {
    let changed = false;
    for (const key of Object.keys(rp)) {
        if (!knownRichPresenceKeys[key]) {
            knownRichPresenceKeys[key] = [];
            changed = true;
        }
        const samples = knownRichPresenceKeys[key];
        const value = String(rp[key]);
        if (!samples.includes(value) && samples.length < MAX_SAMPLE_VALUES_PER_KEY) {
            samples.push(value);
            changed = true;
        }
    }
    if (changed) saveRichPresenceKeys(knownRichPresenceKeys);
}

// Non-match screens whose rich presence is bare (just steam_display, no profit_loss/faction/etc).
// Each one gets synthesized into a $0 round-reset event tagged with its own game_state, and
// buildTrackerEmbed shows its label in place of the Faction line.
const MENU_DISPLAYS = {
    '#Status_Frontend': { gameState: 'frontend', label: 'Main Menu' },
    '#Status_ShootingRange': { gameState: 'shooting_range', label: 'Shooting Range' }
};

const GAME_STATE_MENU_LABELS = Object.fromEntries(
    Object.values(MENU_DISPLAYS).map(({ gameState, label }) => [gameState, label])
);

const ROUND_RESET_STATES = new Set(['pre_match', ...Object.values(MENU_DISPLAYS).map(m => m.gameState)]);

const FACTION_COLORS = {
    alpha: 0x3498DB,
    bravo: 0xED4245,
    charlie: 0x57F287
};

const FACTION_DISPLAY_NAMES = {
    alpha: 'Lonestar',
    bravo: 'Valkyra',
    charlie: 'Manticore'
};

function getFactionDisplayName(faction) {
    if (!faction) return 'Unknown';
    return FACTION_DISPLAY_NAMES[faction.toLowerCase()] || faction;
}

function getTodayDateString() {
    return new Date().toISOString().slice(0, 10);
}

function resetDailyStatsIfNeeded(state) {
    const today = getTodayDateString();
    if (state.statsDate !== today) {
        state.statsDate = today;
        state.winsToday = 0;
        state.lossesToday = 0;
        // Fallback baseline refresh in case the bot was offline across the scheduled
        // midnight reset (see scheduleDailyReset) — keeps dailyStartBalance from going stale.
        if (typeof state.balance === 'number') {
            state.dailyStartBalance = state.balance;
        }
    }
}

function msUntilNextLocalMidnight() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return next - now;
}

function formatDateDDMMYYYY(date) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}

// Discord's own embed timestamp is supposed to re-render as "Today at..." vs an explicit
// date depending on the viewer's clock, but in practice it can be left showing a stale
// "Today at..." well past local midnight. We build and own this label ourselves instead,
// and refreshAllTrackerLabels() periodically re-edits messages so it stays accurate even
// with no new Steam event.
function formatLastUpdatedLabel(timestampMs) {
    if (!timestampMs) return null;
    const date = new Date(timestampMs);
    const now = new Date();
    const isToday = date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
    const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return isToday ? `Today at ${time}` : `${formatDateDDMMYYYY(date)} at ${time}`;
}

async function runDailyReset() {
    // Fires right at local midnight, so "today" per the clock is the day that's about to
    // start — the day we're reporting on is the one that just ended.
    const reportDate = new Date();
    reportDate.setDate(reportDate.getDate() - 1);
    const dateLabel = formatDateDDMMYYYY(reportDate);

    let topSteamId = null;
    let topProfit = -Infinity;
    for (const [steamID64, state] of Object.entries(trackedState)) {
        if (typeof state.balance === 'number' && typeof state.dailyStartBalance === 'number') {
            const profit = state.balance - state.dailyStartBalance;
            if (profit > topProfit) {
                topProfit = profit;
                topSteamId = steamID64;
            }
        }
    }

    if (topSteamId && topProfit > 0) {
        const discordUserId = trackedOwners[topSteamId];
        if (discordUserId) {
            try {
                const user = await discordClient.users.fetch(discordUserId);
                await user.send(`🏆 Congrats! You have earned the most profit today ${dateLabel} in WARDOGS with a total profit of ${formatMoney(topProfit)}.`);
                console.log(`🏆 Sent daily top-earner DM to ${discordUserId} (${topSteamId}) — ${formatMoney(topProfit)}`);
            } catch (err) {
                console.error(`⚠️ Failed to DM daily top earner ${discordUserId}:`, err.message);
            }
        } else {
            console.log(`📊 Top earner for ${dateLabel} was ${topSteamId} (${formatMoney(topProfit)}), but no owner is on file to DM.`);
        }
    } else {
        console.log(`📊 Daily reset for ${dateLabel} — no player had positive profit, skipping top-earner DM.`);
    }

    for (const state of Object.values(trackedState)) {
        state.winsToday = 0;
        state.lossesToday = 0;
        state.statsDate = getTodayDateString();
        if (typeof state.balance === 'number') {
            state.dailyStartBalance = state.balance;
        }
    }
    saveState(trackedState);
}

function scheduleDailyReset() {
    const delay = msUntilNextLocalMidnight();
    console.log(`⏰ Next daily reset scheduled in ${Math.round(delay / 60000)} minute(s).`);
    setTimeout(async () => {
        try {
            await runDailyReset();
        } catch (err) {
            console.error('⚠️ Daily reset failed:', err.message);
        }
        scheduleDailyReset();
    }, delay);
}

async function resolveSteamId(input) {
    input = input.trim();

    if (/^\d{17}$/.test(input)) return input;

    let match = input.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
    if (match) return match[1];

    match = input.match(/steamcommunity\.com\/id\/([^\/\s?]+)/i);
    const vanity = match ? match[1] : input;

    const res = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${process.env.STEAM_API_KEY}&vanityurl=${encodeURIComponent(vanity)}`);
    const data = await res.json();
    return (data.response && data.response.success === 1) ? data.response.steamid : null;
}

function parseMoneyValue(input) {
    if (input === undefined || input === null) return null;
    const cleaned = String(input).replace(/[^0-9.]/g, '');
    if (!cleaned) return null;
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
}

function formatSignedMoney(num) {
    const sign = num < 0 ? '-' : '+';
    return `${sign}$${Math.abs(num).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatMoney(num) {
    const sign = num < 0 ? '-' : '';
    return `${sign}$${Math.abs(num).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function getSignedEventAmount(state) {
    if (!state.amount || !state.label) return 0;
    const magnitude = Math.abs(parseMoneyValue(state.amount) || 0);
    return state.label.toLowerCase() === 'profit' ? magnitude : -magnitude;
}

function isStateCollapsed(state) {
    return state.isCollapsed !== false;
}

function buildTrackerEmbed(steamID64, state) {
    const profileUrl = `https://steamcommunity.com/profiles/${steamID64}`;
    const hasEvent = Boolean(state.amount && state.label);
    const isProfit = hasEvent && state.label.toLowerCase() === 'profit';
    const signedEventAmount = getSignedEventAmount(state);
    const collapsed = isStateCollapsed(state);

    const embed = new EmbedBuilder()
        .setAuthor({ name: state.playerName || steamID64, iconURL: state.avatarUrl || undefined, url: profileUrl })
        .setURL(profileUrl);

    const lastUpdatedLabel = formatLastUpdatedLabel(state.lastEventAt);
    if (lastUpdatedLabel) {
        embed.setFooter({ text: lastUpdatedLabel });
    }

    const descriptionLines = [];

    if (typeof state.balance === 'number') {
        const totalBalance = state.balance + (signedEventAmount - (state.balanceBaselineEvent || 0));
        descriptionLines.push(`💰 Total Balance : ${formatMoney(totalBalance)}`);
    }

    if (state.isOffline) {
        embed.setColor(0x99AAB5);
        descriptionLines.push('⚫ Offline');
    } else if (hasEvent) {
        const factionKey = (state.faction || '').toLowerCase();
        embed.setColor(FACTION_COLORS[factionKey] || 0x5865F2);

        const menuLabel = GAME_STATE_MENU_LABELS[state.lastGameState];
        descriptionLines.push(menuLabel ? `🪖 ${menuLabel}` : `🪖 Faction : ${getFactionDisplayName(state.faction)}`);

        const ESC = String.fromCharCode(27);
        const bgColor = isProfit ? '42' : '41';
        const coloredLine = `${ESC}[1;37;${bgColor}m Current Earnings: ${formatSignedMoney(signedEventAmount)} ${ESC}[0m`;
        descriptionLines.push(`\`\`\`ansi\n${coloredLine}\n\`\`\``);
    } else {
        embed.setColor(0x5865F2);
        descriptionLines.push("No profit/loss recorded yet.");
    }

    if (!collapsed) {
        descriptionLines.push(`✅ Wins Today : ${state.winsToday || 0}`);
        descriptionLines.push(`❌ Losses Today : ${state.lossesToday || 0}`);

        const history = trackedHistory[steamID64] || [];
        if (history.length > 0) {
            descriptionLines.push('');
            descriptionLines.push('📜 Recent History');
            history.slice(-4).reverse().forEach(entry => {
                const icon = entry.change >= 0 ? '🟢' : '🔴';
                const timestamp = `<t:${Math.floor(entry.timestamp / 1000)}:R>`;
                descriptionLines.push(`${icon} **${formatSignedMoney(entry.change)}** — ${formatMoney(entry.balanceBefore)} → ${formatMoney(entry.balanceAfter)} (${getFactionDisplayName(entry.faction)}) ${timestamp}`);
            });
        }
    }

    embed.setDescription(descriptionLines.join('\n'));

    return embed;
}

function buildTrackerComponents(steamID64, state) {
    const collapsed = isStateCollapsed(state);
    const button = new ButtonBuilder()
        .setCustomId(`toggle:${steamID64}`)
        .setLabel(collapsed ? 'Show More ▼' : 'Show Less ▲')
        .setStyle(ButtonStyle.Secondary);
    return [new ActionRowBuilder().addComponents(button)];
}

async function postOrUpdateTracker(steamID64, state) {
    try {
        const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        if (!channel) return;

        const embed = buildTrackerEmbed(steamID64, state);
        const components = buildTrackerComponents(steamID64, state);

        const existingMessageId = trackedMessages[steamID64];
        if (existingMessageId) {
            try {
                const existingMessage = await channel.messages.fetch(existingMessageId);
                await existingMessage.edit({ embeds: [embed], components });
                return;
            } catch {
                console.log(`⚠️ Couldn't find/edit previous message for ${steamID64}, sending a new one.`);
            }
        }

        const sentMessage = await channel.send({ embeds: [embed], components });
        trackedMessages[steamID64] = sentMessage.id;
        saveTrackedMessages(trackedMessages);
    } catch (err) {
        console.error(`⚠️ Failed to post/update tracker for ${steamID64} (will retry on next update):`, err.message);
    }
}

const commands = [
    new SlashCommandBuilder()
        .setName('track')
        .setDescription('Manage which Steam friends are tracked for WARDOGS profit updates')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add yourself to the tracked list')
                .addStringOption(opt => opt.setName('steamid').setDescription('SteamID64, or your steamcommunity.com profile link').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a SteamID64 from the tracked list')
                .addStringOption(opt => opt.setName('steamid').setDescription('SteamID64 to remove').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List currently tracked SteamIDs (empty = tracking everyone)'))
        .addSubcommand(sub =>
            sub.setName('balance')
                .setDescription('Set your current total WARDOGS balance (do this at the Main Menu)')
                .addStringOption(opt => opt.setName('amount').setDescription('Your current total balance, e.g. 1250 or $1,250').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('history')
                .setDescription('View your recent match balance history'))
        .addSubcommand(sub =>
            sub.setName('me')
                .setDescription('Privately view your own tracker card, fully expanded, without the shared channel clutter'))
        .addSubcommand(sub =>
            sub.setName('resetstats')
                .setDescription('Admin: reset wins/losses to 0 for everyone'))
        .addSubcommand(sub =>
            sub.setName('help')
                .setDescription('List all /track commands and what they do'))
].map(cmd => cmd.toJSON());

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    await rest.put(
        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
        { body: commands }
    );
    console.log('📋 Slash commands registered.');
}

const LABEL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function refreshAllTrackerLabels() {
    Object.entries(trackedState).forEach(([steamID64, state]) => {
        if (trackedMessages[steamID64]) {
            postOrUpdateTracker(steamID64, state);
        }
    });
}

discordClient.once('ready', async () => {
    console.log(`🤖 Discord Bot logged in as ${discordClient.user.tag}`);
    await registerCommands();
    scheduleDailyReset();
    refreshAllTrackerLabels();
    setInterval(refreshAllTrackerLabels, LABEL_REFRESH_INTERVAL_MS);
    steamClient.logOn({
        accountName: process.env.STEAM_ACCOUNT_NAME,
        password: process.env.STEAM_PASSWORD
    });
});

discordClient.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith('toggle:')) {
        const steamID64 = interaction.customId.slice('toggle:'.length);
        const state = trackedState[steamID64];
        if (!state) {
            await interaction.reply({ content: '⚠️ No data for this player yet.', ephemeral: true });
            return;
        }

        state.isCollapsed = !isStateCollapsed(state);
        trackedState[steamID64] = state;
        saveState(trackedState);

        await interaction.update({
            embeds: [buildTrackerEmbed(steamID64, state)],
            components: buildTrackerComponents(steamID64, state)
        });
        return;
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== 'track') return;

    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
        const existingOwnedId = Object.keys(trackedOwners).find(id => trackedOwners[id] === interaction.user.id);
        if (existingOwnedId) {
            await interaction.reply({ content: `⚠️ You're already tracking \`${existingOwnedId}\`. Use \`/track remove steamid:${existingOwnedId}\` first if you want to switch accounts.`, ephemeral: true });
            return;
        }

        const rawInput = interaction.options.getString('steamid');
        await interaction.deferReply();

        const steamid = await resolveSteamId(rawInput);
        if (!steamid) {
            await interaction.editReply('⚠️ Could not resolve that to a Steam account. Try a raw SteamID64, or a profile link like `steamcommunity.com/id/yourname` or `steamcommunity.com/profiles/765...`.');
            return;
        }

        if (!trackedFriends.includes(steamid)) {
            trackedFriends.push(steamid);
            saveTrackedFriends(trackedFriends);
        }

        trackedOwners[steamid] = interaction.user.id;
        saveOwners(trackedOwners);

        await interaction.editReply(`Added \`${steamid}\` to tracked list. Please use Friend Code ${process.env.STEAM_FRIEND_CODE} and add ${process.env.STEAM_ACCOUNT_NAME} on Steam.`);
    } else if (sub === 'remove') {
        const steamid = interaction.options.getString('steamid');
        trackedFriends = trackedFriends.filter(id => id !== steamid);
        saveTrackedFriends(trackedFriends);

        delete trackedOwners[steamid];
        saveOwners(trackedOwners);

        await interaction.reply(`🗑️ Stopped tracking \`${steamid}\`.`);
    } else if (sub === 'list') {
        if (trackedFriends.length === 0) {
            await interaction.reply('No SteamIDs are on the whitelist — currently tracking **all** friends.');
        } else {
            await interaction.reply(`Tracking:\n${trackedFriends.map(id => `- \`${id}\``).join('\n')}`);
        }
    } else if (sub === 'balance') {
        const ownedSteamId = Object.keys(trackedOwners).find(id => trackedOwners[id] === interaction.user.id);
        if (!ownedSteamId) {
            await interaction.reply({ content: '⚠️ You need to `/track add` your SteamID before you can set a balance.', ephemeral: true });
            return;
        }

        const rawAmount = interaction.options.getString('amount');
        const parsedAmount = parseMoneyValue(rawAmount);
        if (parsedAmount === null) {
            await interaction.reply({ content: '⚠️ Could not parse that as a number. Try something like `1250` or `$1,250`.', ephemeral: true });
            return;
        }

        const state = trackedState[ownedSteamId] || {};
        state.balance = parsedAmount;
        state.balanceBaselineEvent = getSignedEventAmount(state);
        if (typeof state.dailyStartBalance !== 'number') {
            state.dailyStartBalance = parsedAmount;
        }
        trackedState[ownedSteamId] = state;
        saveState(trackedState);

        await postOrUpdateTracker(ownedSteamId, state);

        await interaction.reply({ content: `💰 Balance set to ${formatMoney(parsedAmount)}. Be sure you only enter this number when you are at the Main Menu in game.`, ephemeral: true });
    } else if (sub === 'history') {
        const ownedSteamId = Object.keys(trackedOwners).find(id => trackedOwners[id] === interaction.user.id);
        if (!ownedSteamId) {
            await interaction.reply({ content: '⚠️ You need to `/track add` your SteamID first.', ephemeral: true });
            return;
        }

        const history = trackedHistory[ownedSteamId] || [];
        if (history.length === 0) {
            await interaction.reply({ content: '📜 No match history recorded yet. Matches are logged once you set a balance with `/track balance` and finish a round.', ephemeral: true });
            return;
        }

        const lines = history.slice(-10).reverse().map(entry => {
            const icon = entry.change >= 0 ? '🟢' : '🔴';
            const timestamp = `<t:${Math.floor(entry.timestamp / 1000)}:R>`;
            return `${icon} **${formatSignedMoney(entry.change)}** — ${formatMoney(entry.balanceBefore)} → ${formatMoney(entry.balanceAfter)} (${getFactionDisplayName(entry.faction)}) ${timestamp}`;
        });

        const state = trackedState[ownedSteamId] || {};
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📜 Match History')
            .setAuthor({ name: state.playerName || ownedSteamId })
            .setDescription(lines.join('\n'));

        await interaction.reply({ embeds: [embed], ephemeral: true });
    } else if (sub === 'me') {
        const ownedSteamId = Object.keys(trackedOwners).find(id => trackedOwners[id] === interaction.user.id);
        if (!ownedSteamId) {
            await interaction.reply({ content: '⚠️ You need to `/track add` your SteamID first.', ephemeral: true });
            return;
        }

        const state = trackedState[ownedSteamId];
        if (!state) {
            await interaction.reply({ content: '📭 No data recorded for you yet.', ephemeral: true });
            return;
        }

        const embed = buildTrackerEmbed(ownedSteamId, { ...state, isCollapsed: false });
        await interaction.reply({ embeds: [embed], ephemeral: true });
    } else if (sub === 'resetstats') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: '⚠️ You need Administrator permission to use this.', ephemeral: true });
            return;
        }

        const steamIds = Object.keys(trackedState);
        steamIds.forEach(steamID64 => {
            trackedState[steamID64].winsToday = 0;
            trackedState[steamID64].lossesToday = 0;
        });
        saveState(trackedState);

        await Promise.all(steamIds
            .filter(steamID64 => trackedMessages[steamID64])
            .map(steamID64 => postOrUpdateTracker(steamID64, trackedState[steamID64])));

        await interaction.reply({ content: `🔄 Wins/losses reset to 0 for ${steamIds.length} tracked player(s).`, ephemeral: true });
    } else if (sub === 'help') {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📖 /track Commands')
            .setDescription([
                '`/track add <steamid>` — Add yourself to the tracked list. Accepts a raw SteamID64 or a steamcommunity.com profile link.',
                '`/track remove <steamid>` — Stop tracking a SteamID and release your ownership of it.',
                '`/track list` — List currently tracked SteamIDs (empty list = tracking everyone).',
                '`/track balance <amount>` — Set your current total WARDOGS balance. Only do this at the Main Menu.',
                '`/track history` — Privately view your last 10 banked match results.',
                '`/track me` — Privately view your own tracker card, fully expanded.',
                '`/track resetstats` — **Admin only.** Reset wins/losses to 0 for everyone.',
                '`/track help` — Show this list.'
            ].join('\n'));

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
});

// steam-user's own auto-subscribe (on the initial post-login friends list load) only
// captures a snapshot of rich-presence data at that moment. A friend who is offline at
// login and comes online later never gets (re)subscribed, so their rich presence updates
// never arrive — until a restart re-runs the login subscribe. Force a fresh subscription
// on a short interval so newly-online friends get picked up without a restart.
const RESUBSCRIBE_INTERVAL_MS = 10 * 1000;

function resubscribeToFriendPersonas() {
    const ids = trackedFriends.length > 0 ? trackedFriends : Object.keys(steamClient.myFriends || {});
    if (ids.length === 0) return;
    steamClient.getPersonas(ids, (err) => {
        if (err) console.error('⚠️ Failed to refresh friend persona subscriptions:', err.message);
    });
}

steamClient.on('loggedOn', () => {
    console.log('🎮 Steam Bot successfully logged into Steam!');
    steamClient.setPersona(SteamUser.EPersonaState.Invisible);
    resubscribeToFriendPersonas();
    setInterval(resubscribeToFriendPersonas, RESUBSCRIBE_INTERVAL_MS);
});

steamClient.on('error', (err) => {
    console.error('⚠️ Steam client error:', err.message);
});

steamClient.on('friendRelationship', (steamID, relationship) => {
    if (relationship === SteamUser.EFriendRelationship.RequestRecipient) {
        console.log(`🤝 Accepting incoming friend request from ${steamID.getSteamID64()}`);
        steamClient.addFriend(steamID, (err) => {
            if (err) {
                console.error(`Failed to accept friend request from ${steamID.getSteamID64()}:`, err.message);
                return;
            }

            // Force-subscribe to this new friend's full persona/rich-presence data now,
            // since Steam only auto-subscribes friends present at the initial post-login load.
            steamClient.getPersonas([steamID], (err2) => {
                if (err2) console.error(`Failed to fetch persona data for new friend ${steamID.getSteamID64()}:`, err2.message);
            });
        });
    }
});

steamClient.on('steamGuard', (domain, callback) => {
    console.log('\n🔐 Steam Guard Code Required!');
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });
    readline.question('Enter your Steam Guard Code: ', (code) => {
        callback(code);
        readline.close();
    });
});

steamClient.on('user', async (steamID, persona) => {
    const steamID64 = steamID.getSteamID64();
    if (trackedFriends.length > 0 && !trackedFriends.includes(steamID64)) return;

    // Anything other than an active WARDOGS rich-presence session (offline, online but not
    // in WARDOGS, playing something else, etc.) counts as "Offline" for display purposes.
    const isShowingWardogs = persona.game_played_app_id === 1867240 && Boolean(persona.rich_presence);
    if (!isShowingWardogs) {
        const existingState = trackedState[steamID64];
        if (existingState && !existingState.isOffline) {
            existingState.isOffline = true;
            trackedState[steamID64] = existingState;
            saveState(trackedState);
            await postOrUpdateTracker(steamID64, existingState);
            console.log(`⚫ ${steamID64} no longer showing WARDOGS presence — marked Offline.`);
        }
        return;
    }

    const rp = {};
    persona.rich_presence.forEach(token => { rp[token.key] = token.value; });
    console.log(`🐕 WARDOGS presence update from ${steamID64}:`, JSON.stringify(rp));

    recordRichPresenceKeys(rp);

    const menuInfo = MENU_DISPLAYS[rp.steam_display];
    if (menuInfo) {
        // Menu-screen presence is bare (just steam_display, no other tokens) —
        // synthesize a round-reset event so it banks and shows +$0 like a fresh match start.
        rp.profit_loss = '$0';
        rp.in_profit_or_loss = 'profit';
        rp.faction = rp.faction || 'unknown';
        rp.game_state = menuInfo.gameState;
    }

    const amount = rp.profit_loss;
    const label = rp.in_profit_or_loss;
    if (!amount || !label) return;

    const state = trackedState[steamID64] || {};
    resetDailyStatsIfNeeded(state);

    if (rp.game_state === 'match_won' && state.lastGameState !== 'match_won') {
        state.winsToday += 1;
        console.log(`✅ Win recorded for ${steamID64} — ${state.winsToday} today`);
    } else if (rp.game_state === 'match_lost' && state.lastGameState !== 'match_lost') {
        state.lossesToday += 1;
        console.log(`❌ Loss recorded for ${steamID64} — ${state.lossesToday} today`);
    }

    const isNewRound = typeof state.balance === 'number' && ROUND_RESET_STATES.has(rp.game_state) && !ROUND_RESET_STATES.has(state.lastGameState);
    if (isNewRound) {
        const outgoingSignedAmount = getSignedEventAmount(state);
        const change = outgoingSignedAmount - (state.balanceBaselineEvent || 0);
        const balanceBefore = state.balance;
        state.balance += change;
        state.balanceBaselineEvent = 0;
        console.log(`💰 New round detected for ${steamID64} — banked previous round, balance now ${formatMoney(state.balance)}`);

        if (change !== 0) {
            const history = trackedHistory[steamID64] || [];
            history.push({
                timestamp: Date.now(),
                faction: state.faction || 'Unknown',
                balanceBefore,
                balanceAfter: state.balance,
                change
            });
            if (history.length > MAX_HISTORY_PER_PLAYER) history.shift();
            trackedHistory[steamID64] = history;
            saveHistory(trackedHistory);
        }
    }
    state.lastGameState = rp.game_state;

    state.playerName = persona.player_name;
    state.avatarUrl = persona.avatar_url_medium;
    state.amount = amount;
    state.label = label;
    state.faction = rp.faction ? rp.faction.charAt(0).toUpperCase() + rp.faction.slice(1) : 'Unknown';
    state.lastEventAt = Date.now();
    state.isOffline = false;

    trackedState[steamID64] = state;
    saveState(trackedState);

    await postOrUpdateTracker(steamID64, state);
    console.log(`🚀 Updated tracker for ${persona.player_name}`);
});

discordClient.login(process.env.DISCORD_BOT_TOKEN);
