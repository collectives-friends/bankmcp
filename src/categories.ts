// The chart of accounts. Ids are stable and referenced from transactions, rules
// and budgets; names are what the UI shows.

export type CategoryKind = "income" | "expense" | "transfer";

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  sort: number;
}

export const DEFAULT_CATEGORIES: Category[] = [
  { id: "salary", name: "Salary", kind: "income", sort: 1 },
  { id: "other_income", name: "Other income", kind: "income", sort: 2 },
  { id: "rental_income", name: "Rental income", kind: "income", sort: 3 },
  { id: "windfall", name: "One-off income", kind: "income", sort: 4 },
  { id: "transfer_in", name: "Transfers in (unlinked accounts)", kind: "income", sort: 5 },
  { id: "contribution_in", name: "Partner contributions to shared accounts", kind: "income", sort: 6 },
  { id: "reimbursement_in", name: "Reimbursed from shared accounts", kind: "income", sort: 7 },

  { id: "housing", name: "Housing", kind: "expense", sort: 10 },
  { id: "utilities", name: "Utilities & telecom", kind: "expense", sort: 11 },
  { id: "insurance", name: "Insurance & pension", kind: "expense", sort: 12 },
  { id: "groceries", name: "Groceries", kind: "expense", sort: 20 },
  { id: "eating_out", name: "Eating out", kind: "expense", sort: 21 },
  { id: "transport", name: "Transport", kind: "expense", sort: 22 },
  { id: "kids", name: "Kids & family", kind: "expense", sort: 23 },
  { id: "health", name: "Health", kind: "expense", sort: 24 },
  { id: "shopping", name: "Shopping", kind: "expense", sort: 30 },
  { id: "subscriptions", name: "Subscriptions", kind: "expense", sort: 31 },
  { id: "entertainment", name: "Entertainment & culture", kind: "expense", sort: 32 },
  { id: "travel", name: "Travel", kind: "expense", sort: 33 },
  { id: "p2p", name: "Payments to people", kind: "expense", sort: 40 },
  { id: "card_settlement", name: "Card payments (card not linked)", kind: "expense", sort: 41 },
  { id: "savings", name: "Savings & investments", kind: "expense", sort: 42 },
  { id: "transfer_out", name: "Transfers out (unlinked accounts)", kind: "expense", sort: 46 },
  { id: "household_contribution", name: "Contribution to shared accounts", kind: "expense", sort: 9 },
  { id: "reimbursement_out", name: "Reimbursements to partners", kind: "expense", sort: 47 },
  { id: "fees", name: "Bank fees & interest", kind: "expense", sort: 43 },
  { id: "tax", name: "Tax", kind: "expense", sort: 44 },
  { id: "charity", name: "Charity & gifts", kind: "expense", sort: 45 },
  { id: "other", name: "Other", kind: "expense", sort: 90 },

  { id: "internal", name: "Internal transfer", kind: "transfer", sort: 99 },
];

/**
 * Seed rules: case-insensitive substrings matched against
 * "<counterparty> <description>". Biased towards Danish merchants; the user
 * refines them from the UI, and user rules always win over these.
 */
export const DEFAULT_RULES: Array<[pattern: string, category: string]> = [
  // income
  ["løn", "salary"], ["loen", "salary"], ["salary", "salary"], ["heyra aps", "salary"],
  ["udbetaling danmark", "other_income"], ["feriekonto", "other_income"], ["borger.dk", "other_income"],

  // housing
  ["husleje", "housing"], ["boligforening", "housing"], ["andelsbolig", "housing"], ["ejerforening", "housing"],
  ["grundejer", "housing"], ["nordea kredit", "housing"], ["realkredit", "housing"], ["totalkredit", "housing"],
  ["nykredit", "housing"], ["boligkredit", "housing"], ["boliglån", "housing"], ["prioritetslån", "housing"],
  ["ejendomsskat", "housing"], ["grundskyld", "housing"], ["terminsydelse", "housing"],
  ["renter", "housing"], // interest posted on a mortgage/credit account; overdraft interest is usually "rente"/"debit interest"

  // utilities & telecom
  ["ørsted", "utilities"], ["orsted", "utilities"], ["andel energi", "utilities"], ["norlys", "utilities"], ["hofor", "utilities"],
  ["radius", "utilities"], ["ewii", "utilities"], ["vandværk", "utilities"], ["fjernvarme", "utilities"], ["modstrøm", "utilities"],
  ["nrgi", "utilities"], ["telia", "utilities"], ["telenor", "utilities"], ["telmore", "utilities"], ["cbb mobil", "utilities"],
  ["oister", "utilities"], ["lebara", "utilities"], ["yousee", "utilities"], ["hiper", "utilities"], ["fibia", "utilities"],
  ["3 danmark", "utilities"], ["stofa", "utilities"], ["eesy", "utilities"], ["greentel", "utilities"], ["fastspeed", "utilities"],

  // insurance & pension
  ["tryg", "insurance"], ["topdanmark", "insurance"], ["alka", "insurance"], ["codan", "insurance"], ["gjensidige", "insurance"],
  ["if forsikring", "insurance"], ["if skadeforsikring", "insurance"], ["lb forsikring", "insurance"], ["gf forsikring", "insurance"],
  ["alm. brand", "insurance"], ["alm brand", "insurance"], ["sygeforsikring", "insurance"], ["danica", "insurance"],
  ["pfa pension", "insurance"], ["velliv", "insurance"], ["ap pension", "insurance"], ["forsikring", "insurance"],

  // groceries
  ["netto", "groceries"], ["rema 1000", "groceries"], ["rema1000", "groceries"], ["føtex", "groceries"], ["foetex", "groceries"],
  ["bilka", "groceries"], ["lidl", "groceries"], ["aldi", "groceries"], ["irma", "groceries"], ["meny", "groceries"],
  ["superbrugsen", "groceries"], ["kvickly", "groceries"], ["brugsen", "groceries"], ["spar ", "groceries"], ["coop", "groceries"],
  ["nemlig", "groceries"], ["løvbjerg", "groceries"], ["abc lavpris", "groceries"], ["7-eleven", "groceries"], ["7 eleven", "groceries"],
  ["bageri", "groceries"], ["slagter", "groceries"], ["grønthandler", "groceries"],

  // eating out
  ["wolt", "eating_out"], ["just eat", "eating_out"], ["just-eat", "eating_out"], ["restaurant", "eating_out"], ["cafe", "eating_out"],
  ["café", "eating_out"], ["pizza", "eating_out"], ["sushi", "eating_out"], ["burger", "eating_out"], ["mcdonald", "eating_out"],
  ["espresso house", "eating_out"], ["joe & the juice", "eating_out"], ["joe and the juice", "eating_out"], ["starbucks", "eating_out"],
  ["lagkagehuset", "eating_out"], ["emmerys", "eating_out"], ["andersen & maillard", "eating_out"], ["bistro", "eating_out"],
  ["grill", "eating_out"], ["kebab", "eating_out"], ["bodega", "eating_out"], ["kro ", "eating_out"], ["hvide lam", "eating_out"],
  ["bar ", "eating_out"], ["brasserie", "eating_out"], ["kaffe", "eating_out"], ["coffee", "eating_out"], ["takeaway", "eating_out"],

  // transport
  ["dsb", "transport"], ["rejsekort", "transport"], ["metro", "transport"], ["movia", "transport"], ["lime", "transport"],
  ["voi ", "transport"], ["donkey republic", "transport"], ["gomore", "transport"], ["share now", "transport"], ["sharenow", "transport"],
  ["greenmobility", "transport"], ["viggo", "transport"], ["uber", "transport"], ["bolt.eu", "transport"], ["taxa", "transport"],
  ["dantaxi", "transport"], ["circle k", "transport"], ["shell", "transport"], ["q8", "transport"], ["uno-x", "transport"],
  ["ok benzin", "transport"], ["ingo", "transport"], ["easypark", "transport"], ["parkering", "transport"], ["apcoa", "transport"],
  ["q-park", "transport"], ["brobizz", "transport"], ["storebælt", "transport"], ["øresund", "transport"], ["swapfiets", "transport"],
  ["drivr", "transport"], ["flixbus", "transport"], ["fdm", "transport"], ["cykel", "transport"],

  // kids & family
  ["vuggestue", "kids"], ["børnehave", "kids"], ["dagpleje", "kids"], ["sfo", "kids"], ["institution", "kids"], ["legetøj", "kids"],
  ["fætter br", "kids"], ["babysam", "kids"], ["ønskebørn", "kids"], ["lego", "kids"], ["skole", "kids"],

  // health
  ["apotek", "health"], ["læge", "health"], ["tandlæge", "health"], ["tandlaege", "health"], ["fysioterap", "health"],
  ["kiropraktor", "health"], ["matas", "health"], ["psykolog", "health"], ["optiker", "health"], ["synoptik", "health"],
  ["louis nielsen", "health"], ["profil optik", "health"], ["hospital", "health"],

  // shopping
  ["amazon", "shopping"], ["zalando", "shopping"], ["h&m", "shopping"], ["h & m", "shopping"], ["ikea", "shopping"], ["jysk", "shopping"],
  ["elgiganten", "shopping"], ["power.dk", "shopping"], ["normal ", "shopping"], ["søstrene grene", "shopping"], ["boozt", "shopping"],
  ["asos", "shopping"], ["magasin", "shopping"], ["illum", "shopping"], ["bahne", "shopping"], ["imerco", "shopping"],
  ["kop & kande", "shopping"], ["bog & idé", "shopping"], ["apple store", "shopping"], ["ebay", "shopping"], ["temu", "shopping"],
  ["shein", "shopping"], ["trendsales", "shopping"], ["dba.dk", "shopping"], ["wish.com", "shopping"], ["bauhaus", "shopping"],
  ["silvan", "shopping"], ["harald nyborg", "shopping"], ["plantorama", "shopping"],

  // subscriptions
  ["netflix", "subscriptions"], ["spotify", "subscriptions"], ["hbo", "subscriptions"], ["disney", "subscriptions"], ["viaplay", "subscriptions"],
  ["tv 2 play", "subscriptions"], ["tv2 play", "subscriptions"], ["apple.com/bill", "subscriptions"], ["apple services", "subscriptions"],
  ["icloud", "subscriptions"], ["google one", "subscriptions"], ["google *", "subscriptions"], ["youtube", "subscriptions"],
  ["adobe", "subscriptions"], ["openai", "subscriptions"], ["chatgpt", "subscriptions"], ["anthropic", "subscriptions"], ["claude.ai", "subscriptions"],
  ["github", "subscriptions"], ["notion", "subscriptions"], ["dropbox", "subscriptions"], ["microsoft", "subscriptions"],
  ["amazon prime", "subscriptions"], ["audible", "subscriptions"], ["storytel", "subscriptions"], ["mofibo", "subscriptions"],
  ["podimo", "subscriptions"], ["patreon", "subscriptions"], ["zetland", "subscriptions"], ["politiken", "subscriptions"],
  ["berlingske", "subscriptions"], ["weekendavisen", "subscriptions"], ["fitness world", "subscriptions"], ["sats", "subscriptions"],
  ["puregym", "subscriptions"], ["fitness dk", "subscriptions"], ["linkedin", "subscriptions"], ["nytimes", "subscriptions"],
  ["1password", "subscriptions"], ["cursor", "subscriptions"], ["vercel", "subscriptions"], ["cloudflare", "subscriptions"],

  // entertainment & culture
  ["kino", "entertainment"], ["cinema", "entertainment"], ["nordisk film", "entertainment"], ["cinemaxx", "entertainment"],
  ["biograf", "entertainment"], ["teater", "entertainment"], ["tivoli", "entertainment"], ["zoo", "entertainment"], ["museum", "entertainment"],
  ["billetlugen", "entertainment"], ["ticketmaster", "entertainment"], ["eventim", "entertainment"], ["koncert", "entertainment"],
  ["playstation", "entertainment"], ["steam", "entertainment"], ["nintendo", "entertainment"], ["xbox", "entertainment"],

  // travel
  ["sas ", "travel"], ["norwegian", "travel"], ["ryanair", "travel"], ["easyjet", "travel"], ["lufthansa", "travel"], ["klm", "travel"],
  ["airbnb", "travel"], ["booking.com", "travel"], ["hotels.com", "travel"], ["hotel", "travel"], ["expedia", "travel"],
  ["hostel", "travel"], ["dfds", "travel"], ["molslinjen", "travel"], ["scandlines", "travel"], ["momondo", "travel"],

  // payments to people
  ["mobilepay", "p2p"],

  // card settlement (only used when the card account itself is not linked)
  ["mastercard", "card_settlement"], ["kortbetaling", "card_settlement"],

  // savings & investments
  ["opsparing", "savings"], ["nordnet", "savings"], ["saxo bank", "savings"], ["investering", "savings"], ["aktie", "savings"],
  ["ratepension", "savings"], ["aldersopsparing", "savings"], ["børneopsparing", "savings"],

  // bank fees & interest
  ["gebyr", "fees"], ["rente", "fees"], ["interest", "fees"], ["rykker", "fees"], ["overtræk", "fees"], ["årsgebyr", "fees"],

  // tax
  ["skat", "tax"], ["skattestyrelsen", "tax"], ["restskat", "tax"], ["afgift", "tax"], ["bøde", "tax"],

  // charity & gifts
  ["hospitalsklovne", "charity"], ["røde kors", "charity"], ["red barnet", "charity"], ["unicef", "charity"], ["læger uden grænser", "charity"],
  ["kræftens bekæmpelse", "charity"], ["donation", "charity"], ["velgørenhed", "charity"], ["folkekirkens nødhjælp", "charity"],

  // one-off income (only applies to money coming in)
  ["advokat", "windfall"], ["arv", "windfall"], ["tilbagebetaling", "windfall"], ["refusion", "windfall"],

  // rental income: Airbnb pays hosts out through Visa Payments Ltd
  ["visa payments limited", "rental_income"], ["airbnb payments", "rental_income"], ["udlejning", "rental_income"],

  // transfers to and from accounts that are not linked here
  ["fra nemkonto", "transfer_in"], ["fra nem konto", "transfer_in"], ["fra konto", "transfer_in"], ["overførsel fra", "transfer_in"],
  ["til nemkonto", "transfer_out"], ["til nem konto", "transfer_out"], ["til konto", "transfer_out"], ["overførsel til", "transfer_out"],

  // second pass of merchants seen in the wild
  ["e/f ", "housing"], ["ejerlejlighed", "housing"], ["self storage", "housing"], ["pelican", "housing"], ["boligstøtte", "housing"],
  ["netlify", "subscriptions"], ["elevenlabs", "subscriptions"], ["supabase", "subscriptions"], ["heroku", "subscriptions"], ["railway", "subscriptions"],
  ["figma", "subscriptions"], ["slack", "subscriptions"], ["zoom", "subscriptions"], ["canva", "subscriptions"],
  ["gelato", "eating_out"], ["ismageri", "eating_out"], ["is-mageri", "eating_out"], ["bodeg", "eating_out"], ["pub ", "eating_out"], ["pub & ", "eating_out"],
  ["restaur", "eating_out"], ["mercato", "eating_out"], ["hverdagsk", "eating_out"], ["køkken", "eating_out"], ["vinbar", "eating_out"], ["bryghus", "eating_out"],
  ["jem & fix", "shopping"], ["jem&fix", "shopping"], ["stark", "shopping"], ["xl-byg", "shopping"], ["hejoscar", "shopping"], ["lyspunktet", "shopping"],
  ["mobilepay altid energi", "utilities"], ["altid energi", "utilities"], ["mobilepay flexii", "utilities"], ["flexii", "utilities"],
  ["foreningen", "entertainment"], ["festival", "entertainment"], ["udlæg", "p2p"],
  ["biludlejning", "transport"], ["car rental", "transport"], ["hertz", "transport"], ["avis ", "transport"], ["sixt", "transport"], ["europcar", "transport"], ["enterprise kastrup", "transport"],
  ["a-kasse", "insurance"], ["akademikernes", "insurance"], ["alensa", "health"], ["lenstore", "health"], ["mini rodini", "kids"], ["minirodini", "kids"],
  ["intersport", "shopping"], ["sportsmaster", "shopping"], ["sport 24", "shopping"], ["caf±", "eating_out"], ["cafe", "eating_out"],
];
