export const stages = ["New", "Contacted", "Tour scheduled", "Offer", "Won"] as const;
export type Stage = (typeof stages)[number];
export type DemoContact = { id: string; name: string; interest: string; stage: Stage; value: number };
export type DemoTask = { id: string; title: string; done: boolean };
export function sampleContacts(): DemoContact[] {
  return [
    {
      id: "sample-1",
      name: "Alex Sample",
      interest: "Summerlin · 3 bedrooms",
      stage: "Tour scheduled",
      value: 625000,
    },
    {
      id: "sample-2",
      name: "Jordan Example",
      interest: "Henderson · family home",
      stage: "New",
      value: 480000,
    },
    {
      id: "sample-3",
      name: "Taylor Fiction",
      interest: "Las Vegas · condominium",
      stage: "Contacted",
      value: 315000,
    },
    { id: "sample-4", name: "Morgan Demo", interest: "Summerlin · seller", stage: "Offer", value: 740000 },
  ];
}
export function sampleTasks(): DemoTask[] {
  return [
    { id: "task-1", title: "Prepare a sample tour itinerary for Alex", done: false },
    { id: "task-2", title: "Review Jordan’s fictional home preferences", done: false },
    { id: "task-3", title: "Prepare Morgan’s sample listing draft", done: true },
  ];
}
export function addDemoContact(contacts: DemoContact[], name: string, interest: string, id: string) {
  const cleanName = name.trim();
  const cleanInterest = interest.trim();
  if (
    !cleanName ||
    cleanName.length > 80 ||
    cleanInterest.length > 160 ||
    contacts.length >= 100 ||
    contacts.some((item) => item.id === id)
  )
    throw new Error("Use a fictional name and keep the preview below 100 contacts.");
  return [
    ...contacts,
    { id, name: cleanName, interest: cleanInterest || "Sample buyer", stage: "New" as const, value: 0 },
  ];
}
export function changeDemoStage(contacts: DemoContact[], id: string, stage: Stage) {
  if (!stages.includes(stage)) throw new Error("Choose a supported stage.");
  return contacts.map((contact) => (contact.id === id ? { ...contact, stage } : contact));
}
export function sampleMetrics(contacts: DemoContact[], tasks: DemoTask[]) {
  return {
    contacts: contacts.length,
    opportunities: contacts.filter((item) => item.stage !== "Won").length,
    pipeline: contacts.filter((item) => item.stage !== "Won").reduce((sum, item) => sum + item.value, 0),
    tasks: tasks.filter((item) => !item.done).length,
  };
}
export const sampleListings = [
  {
    id: "listing-1",
    title: "The Summerlin sample",
    area: "Summerlin",
    price: 625000,
    beds: 3,
    baths: 2,
    size: 2150,
    style: "Desert modern",
    tone: "sand",
  },
  {
    id: "listing-2",
    title: "The Henderson example",
    area: "Henderson",
    price: 480000,
    beds: 4,
    baths: 3,
    size: 2380,
    style: "Courtyard living",
    tone: "sage",
  },
  {
    id: "listing-3",
    title: "The Las Vegas demo",
    area: "Las Vegas",
    price: 315000,
    beds: 2,
    baths: 2,
    size: 1260,
    style: "City condominium",
    tone: "blue",
  },
] as const;
