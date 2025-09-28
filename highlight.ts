import Ajv, {JSONSchemaType} from 'ajv';
import {Mwn} from 'mwn';
import parser from 'node-html-parser';

interface Config {
	groups: {
		[key: string]: {
			color: string;
			cssVar: string;
		};
	};
	overrides: {
		add: {
			[key: string]: string[];
		};
		remove: {
			[key: string]: string[];
		};
	};
}

const schema: JSONSchemaType<Config> = {
	type: 'object',
	required: ['groups', 'overrides'],
	properties: {
		groups: {
			type: 'object',
			required: [],
			additionalProperties: {
				type: 'object',
				required: ['color', 'cssVar'],
				properties: {
					color: {
						type: 'string',
						minLength: 1,
					},
					cssVar: {
						type: 'string',
						minLength: 1,
					},
				},
			},
		},
		overrides: {
			type: 'object',
			required: ['add', 'remove'],
			properties: {
				add: {
					type: 'object',
					required: [],
					additionalProperties: {
						type: 'array',
						items: {
							type: 'string',
						},
					},
				},
				remove: {
					type: 'object',
					required: [],
					additionalProperties: {
						type: 'array',
						items: {
							type: 'string',
						},
					},
				},
			},
		},
	},
};

async function getUsers({groups, overrides}: Config) {
	const users: Record<string, string[]> = {};
	const searchParams: Record<string, string> = {};
	let index = 0;
	for (const group in groups) {
		searchParams[`groups[${index++}]`] = group;
		users[group] = [];
	}
	const response = await fetch(`https://dev.fandom.com/wiki/Special:ListGlobalUsers?${new URLSearchParams(searchParams)}`);
	const html = await response.text();
	const tree = parser.parse(html);
	for (const node of tree.querySelectorAll('.list-global-users-members > li')) {
		const name = node.querySelector('bdi')?.innerText;
		const userGroupsMatch = node.innerText
			.trim()
			.match(/\(([^)]+)\)$/);
		if (!name || !userGroupsMatch) {
			continue;
		}
		const userGroups = userGroupsMatch[1].split(', ');
		if (userGroups.includes('bot-global')) {
			continue;
		}
		const toRemove = new Set(overrides.remove[name] || []);
		for (const group of userGroups) {
			if (users[group] && !toRemove.has(group)) {
				users[group].push(name);
			}
		}
	}
	for (const user in overrides.add) {
		for (const group of overrides.add[user]) {
			if (users[group] && !users[group].includes(user)) {
				users[group].push(user);
			}
		}
	}
	return users;
}

async function getConfig(bot: Mwn): Promise<Config> {
	const configPage = await bot.read('MediaWiki:Custom-Highlight.json');
	if (!configPage.revisions || !configPage.revisions[0] || !configPage.revisions[0].content) {
		throw new Error('failed to retrieve configuration page content');
	}
	const config = JSON.parse(configPage.revisions[0].content);
	const ajv = new Ajv();
	const validate = ajv.compile(schema);
	if (!validate(config)) {
		throw new Error(`invalid configuration: ${ajv.errorsText(validate.errors)}`);
	}
	return config;
}

async function init() {
	const bot = new Mwn({
		apiUrl: 'https://dev.fandom.com/api.php',
		password: process.env.PASSWORD,
		silent: true,
		userAgent: 'Highlight.css updater',
		username: process.env.USERNAME,
	});
	await bot.login();
	const config = await getConfig(bot);
	const users = await getUsers(config);
	const css = Object.keys(users)
		.filter(group => users[group].length > 0)
		.map(group => `/* ${group} */\n${users[group]
			.sort()
			.flatMap(user => {
				const regularEncode = user.replace(/\s/g, '_');
				const wikiEncode = encodeURIComponent(user)
					.replace(/'/g, '%27')
					.replace(/%20/g, '_')
					.replace(/%3B/g, ';')
					.replace(/%40/g, '@')
					.replace(/%24/g, '$')
					.replace(/%2C/g, ',')
					.replace(/%2F/g, '/')
					.replace(/%3A/g, ':');
				if (regularEncode === wikiEncode) {
					return [regularEncode];
				}
				return [regularEncode, wikiEncode];
			})
			.map(sel => `a[href$=":${sel}"]`)
			.join(',\n')} {\n\tcolor: ${config.groups[group].color} !important;\n	color: var(--highlight-${config.groups[group].cssVar}) !important;\n}`)
		.join('\n\n');
	const response = await bot.edit('MediaWiki:Highlight.css', ({content}) => ({
		bot: true,
		minor: true,
		summary: 'Automatically updating via [[github:WikiaUsers/highlight|GitHub Actions]] - adjust [[MediaWiki:Custom-Highlight.json|config]] or contact [[Special:ListUsers/sysop|admins]] in case of malfunction',
		text: content.replace(
			/(\/\* HighlightUpdate-start \*\/\n)[\s\S]*$/igm,
			(_, m) => `${m}${css}`
		),
	}));
	if (response.result !== 'Success') {
		throw new Error(`edit result ${response.result}`);
	}
}

init();
