import type { EntityType } from '@/lib/db/types';

export interface CuratedEntity {
  id: string;            // stable slug used as targets.id when no CIK
  name: string;          // canonical display name
  aliases: string[];     // additional strings the resolver should match
  entity_type: EntityType;
  business_line_guess?: 'ecm' | 'dcm' | 'alts';
  metadata?: Record<string, string>;
}

// Sovereigns (no SEC filings; ingestion relies on news + GDELT + FRED macro)
export const sovereigns: CuratedEntity[] = [
  { id: 'sovereign-us',     name: 'United States',  aliases: ['usa', 'us treasury', 'united states of america'], entity_type: 'sovereign', business_line_guess: 'dcm' },
  { id: 'sovereign-uk',     name: 'United Kingdom', aliases: ['uk', 'gilts', 'britain'], entity_type: 'sovereign', business_line_guess: 'dcm' },
  { id: 'sovereign-mexico', name: 'Mexico',         aliases: ['mexico sovereign', 'umbs', 'gobierno de mexico'], entity_type: 'sovereign', business_line_guess: 'dcm' },
  { id: 'sovereign-canada', name: 'Canada',         aliases: ['canada sovereign', 'goc'], entity_type: 'sovereign', business_line_guess: 'dcm' },
  { id: 'sovereign-japan',  name: 'Japan',          aliases: ['jgb', 'japan sovereign'], entity_type: 'sovereign', business_line_guess: 'dcm' },
  { id: 'sovereign-brazil', name: 'Brazil',         aliases: ['brazil sovereign', 'brl'], entity_type: 'sovereign', business_line_guess: 'dcm' },
  { id: 'sovereign-india',  name: 'India',          aliases: ['india sovereign', 'gsec'], entity_type: 'sovereign', business_line_guess: 'dcm' },
];

// US municipalities + agencies (GO bonds, revenue bonds; news + MSRB/GDELT)
export const munis: CuratedEntity[] = [
  { id: 'muni-nyc',        name: 'New York City',           aliases: ['nyc', 'nyc go bonds', 'new york city general obligation'], entity_type: 'muni', business_line_guess: 'dcm' },
  { id: 'muni-california',  name: 'State of California',     aliases: ['california', 'california go', 'state of california general obligation'], entity_type: 'muni', business_line_guess: 'dcm' },
  { id: 'muni-texas',       name: 'State of Texas',          aliases: ['texas', 'texas go'], entity_type: 'muni', business_line_guess: 'dcm' },
  { id: 'muni-florida',     name: 'State of Florida',        aliases: ['florida', 'florida go'], entity_type: 'muni', business_line_guess: 'dcm' },
  { id: 'muni-mta',         name: 'Metropolitan Transportation Authority', aliases: ['mta', 'mta bonds', 'metropolitan transit authority'], entity_type: 'muni', business_line_guess: 'dcm' },
  { id: 'muni-port-authority', name: 'Port Authority of NY/NJ', aliases: ['port authority', 'panynj', 'port authority bonds'], entity_type: 'muni', business_line_guess: 'dcm' },
];

// Well-known private companies (no SEC filings; ingestion via news + GDELT + USPTO)
export const privates: CuratedEntity[] = [
  { id: 'priv-stripe',      name: 'Stripe',         aliases: ['stripe inc', 'stripe payments'], entity_type: 'private_company', business_line_guess: 'ecm' },
  { id: 'priv-databricks',  name: 'Databricks',     aliases: ['databricks inc'], entity_type: 'private_company', business_line_guess: 'ecm' },
  { id: 'priv-openai',      name: 'OpenAI',         aliases: ['open ai', 'openai inc'], entity_type: 'private_company', business_line_guess: 'alts' },
  { id: 'priv-anthropic',   name: 'Anthropic',      aliases: ['anthropic pbc'], entity_type: 'private_company', business_line_guess: 'alts' },
  { id: 'priv-spacex',      name: 'SpaceX',         aliases: ['space exploration technologies', 'space x'], entity_type: 'private_company', business_line_guess: 'alts' },
  { id: 'priv-discord',     name: 'Discord',        aliases: ['discord inc'], entity_type: 'private_company', business_line_guess: 'ecm' },
  { id: 'priv-skims',       name: 'Skims',          aliases: ['skims body', 'skims inc'], entity_type: 'private_company', business_line_guess: 'ecm' },
  { id: 'priv-blackstone-n1', name: 'Blackstone N1', aliases: ['n1', 'blackstone n1 division'], entity_type: 'private_company', business_line_guess: 'alts' },
  { id: 'priv-airtrunk',    name: 'AirTrunk',       aliases: ['air trunk', 'airtrunk operating'], entity_type: 'private_company', business_line_guess: 'alts' },
  { id: 'priv-coreweave',   name: 'CoreWeave',      aliases: ['core weave', 'coreweave inc'], entity_type: 'private_company', business_line_guess: 'alts' },
];

export const allCurated: CuratedEntity[] = [...sovereigns, ...munis, ...privates];

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

export function matchCurated(query: string): CuratedEntity | null {
  const normalized = normalizeForMatch(query);
  if (!normalized) return null;

  for (const entity of allCurated) {
    if (normalizeForMatch(entity.name) === normalized) return entity;
    for (const alias of entity.aliases) {
      if (normalizeForMatch(alias) === normalized) return entity;
    }
  }

  for (const entity of allCurated) {
    if (normalizeForMatch(entity.name).startsWith(normalized)) return entity;
    for (const alias of entity.aliases) {
      if (normalizeForMatch(alias).startsWith(normalized)) return entity;
    }
  }

  return null;
}
