const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, 'config', 'games-registry.json');

function parseArgs(argv) {
    const args = { game: null, force: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--game' || a === '-g') {
            args.game = argv[++i];
        } else if (a === '--force' || a === '-f') {
            args.force = true;
        } else if (a === '--help' || a === '-h') {
            args.help = true;
        }
    }
    return args;
}

function derivePrefix(gameId) {
    return gameId
        .split('-')
        .filter(Boolean)
        .map(part => part.charAt(0))
        .join('')
        .toLowerCase();
}

function generateApiKey(gameId) {
    const prefix = derivePrefix(gameId);
    const randomHex = crypto.randomBytes(32).toString('hex');
    return `${prefix}_${randomHex}`;
}

function printUsage() {
    console.log('Usage: node generate-api-key.js --game <gameId> [--force]');
    console.log('');
    console.log('  --game, -g <id>   Game ID as it appears in config/games-registry.json');
    console.log('  --force, -f       Overwrite an existing apiKeyHash');
    console.log('  --help, -h        Show this message');
}

async function mintForGame(gameId, { force = false } = {}) {
    const registryRaw = await fs.readFile(REGISTRY_PATH, 'utf8');
    const registry = JSON.parse(registryRaw);

    const game = registry.games && registry.games[gameId];
    if (!game) {
        const available = Object.keys(registry.games || {});
        const msg = available.length
            ? `Game '${gameId}' not found. Available games: ${available.join(', ')}`
            : `Game '${gameId}' not found and registry has no games defined.`;
        throw new Error(msg);
    }

    if (game.apiKeyHash && !force) {
        throw new Error(
            `Game '${gameId}' already has an apiKeyHash set. ` +
            `Re-run with --force to overwrite (this invalidates the existing key for deployed clients).`
        );
    }

    const apiKey = generateApiKey(gameId);
    const hash = await bcrypt.hash(apiKey, 10);

    game.apiKeyHash = hash;
    await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');

    return { apiKey, hash, displayName: game.displayName || gameId };
}

async function main() {
    const args = parseArgs(process.argv);

    if (args.help || !args.game) {
        printUsage();
        process.exit(args.help ? 0 : 1);
    }

    const { apiKey, hash, displayName } = await mintForGame(args.game, { force: args.force });

    console.log('========================================');
    console.log(`API Key minted for: ${displayName} (${args.game})`);
    console.log('========================================\n');
    console.log('1. Plaintext API key (save now — cannot be recovered from the hash):');
    console.log(`   ${apiKey}\n`);
    console.log('2. Bcrypt hash (already written to games-registry.json):');
    console.log(`   ${hash}\n`);
    console.log('3. Unity client constant:');
    console.log(`   private const string API_KEY = "${apiKey}";\n`);
    console.log('========================================');
    console.log('IMPORTANT: Store the plaintext key in your secret manager.');
    console.log('========================================');
}

if (require.main === module) {
    main().catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
    });
}

module.exports = { mintForGame, derivePrefix, generateApiKey };
