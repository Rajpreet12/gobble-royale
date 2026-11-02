// Turkey names are picked from these lists, never typed, so the field stays family-friendly.

export const ADJECTIVES = [
  "Sir", "Lady", "Captain", "Doctor", "Professor", "Sneaky", "Speedy", "Fancy", "Nervous", "Brave",
  "Turbo", "Crispy", "Saucy", "Lucky", "Grumpy", "Fluffy", "Wobbly", "Mighty", "Sleepy", "Sparkly",
];

export const NOUNS = [
  "Gobbles", "Drumstick", "Butterball", "Wishbone", "Giblet", "Cranberry", "Gravy", "Stuffing", "Feathers", "Waddles",
  "Tom", "Nugget", "Pumpkin", "Biscuit", "Cornbread", "Pecan", "Yam", "Noodle", "Wattle", "Sprout",
];

export const STATES = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "Washington, D.C."], ["FL", "Florida"],
  ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"],
  ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"],
  ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"],
  ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"],
  ["WY", "Wyoming"], ["PR", "Puerto Rico"], ["XX", "Outside the US"],
];

const STATE_CODES = new Set(STATES.map(([code]) => code));
const ADJ = new Set(ADJECTIVES);
const NOUN = new Set(NOUNS);

export const isState = (code) => STATE_CODES.has(code);

// A name is valid only if it is exactly one adjective and one noun from the lists.
export function isName(name) {
  const [adj, noun, ...rest] = String(name ?? "").split(" ");
  return rest.length === 0 && ADJ.has(adj) && NOUN.has(noun);
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
export const randomName = () => `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
