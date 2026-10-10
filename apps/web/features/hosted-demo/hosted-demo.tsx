"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Heart,
  House,
  LayoutDashboard,
  ListTodo,
  Mail,
  PanelTop,
  Plus,
  RotateCcw,
  Search,
  Smartphone,
  Users,
} from "lucide-react";
import { Badge, Button } from "../../../../packages/ui/components";
import {
  addDemoContact,
  changeDemoStage,
  sampleContacts,
  sampleListings,
  sampleMetrics,
  sampleTasks,
  stages,
  type Stage,
} from "./model";
import styles from "./hosted-demo.module.css";

const tabs = [
  { id: "dashboard", label: "Overview", icon: LayoutDashboard },
  { id: "contacts", label: "Contacts & pipeline", icon: Users },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "properties", label: "Properties", icon: House },
  { id: "website", label: "Website draft", icon: PanelTop },
  { id: "messages", label: "Message draft", icon: Mail },
  { id: "install", label: "Install app", icon: Smartphone },
] as const;
type Tab = (typeof tabs)[number]["id"];
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    value,
  );

export default function HostedDemo({ csrf }: { csrf: string }) {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [contacts, setContacts] = useState(sampleContacts);
  const [tasks, setTasks] = useState(sampleTasks);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [interest, setInterest] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [area, setArea] = useState("All areas");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [selectedListing, setSelectedListing] = useState<string | null>(null);
  const [headline, setHeadline] = useState("Find your next chapter in Las Vegas");
  const [description, setDescription] = useState(
    "Thoughtful local guidance, from the first conversation to your next front door.",
  );
  const [subject, setSubject] = useState("Your next home starts with a conversation");
  const [message, setMessage] = useState(
    "Hi Alex,\n\nHere are a few fictional homes to explore in our preview. Let’s build a plan for your next chapter.\n\nYour sample real estate team",
  );
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const metrics = sampleMetrics(contacts, tasks);
  const changed = () => {
    setDirty(true);
    setNotice("");
  };
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => {});
    const handler = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  function reset() {
    if (!window.confirm("Reset every temporary change in this preview?")) return;
    setContacts(sampleContacts());
    setTasks(sampleTasks());
    setFavorites([]);
    setSelectedListing(null);
    setHeadline("Find your next chapter in Las Vegas");
    setDescription("Thoughtful local guidance, from the first conversation to your next front door.");
    setSubject("Your next home starts with a conversation");
    setMessage(
      "Hi Alex,\n\nHere are a few fictional homes to explore in our preview. Let’s build a plan for your next chapter.\n\nYour sample real estate team",
    );
    setName("");
    setInterest("");
    setTaskTitle("");
    setDirty(false);
    setNotice("Sample data restored.");
  }
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar} aria-label="Workspace navigation">
        <a className={styles.wordmark} href="/demo">
          Estate<span> / preview</span>
        </a>
        <p className={styles.organization}>Sample Real Estate Team</p>
        <nav>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setTab(id);
                setNotice("");
              }}
              className={tab === id ? styles.active : ""}
              aria-current={tab === id ? "page" : undefined}
            >
              <Icon size={19} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
        <div className={styles.sidebarBottom}>
          <p>Fictional data · temporary edits</p>
          <form
            action="/demo/logout"
            method="post"
            onSubmit={(event) => {
              if (dirty && !window.confirm("Sign out and discard your temporary preview changes?"))
                event.preventDefault();
            }}
          >
            <input type="hidden" name="csrf" value={csrf} />
            <button type="submit">Sign out</button>
          </form>
        </div>
      </aside>
      <div className={styles.content}>
        <header className={styles.header}>
          <span>
            <Badge tone="warning">Proof of concept</Badge>{" "}
            <span className={styles.headerNote}>No live MLS or delivery</span>
          </span>
          <Button variant="quiet" onClick={reset}>
            <RotateCcw size={16} aria-hidden="true" /> Reset preview
          </Button>
        </header>
        <main className={styles.main}>
          <div className={styles.title}>
            <div>
              <p className={styles.eyebrow}>YOUR REAL ESTATE WORKSPACE</p>
              <h1>{tabs.find((item) => item.id === tab)?.label}</h1>
            </div>
            <span className={styles.avatar} aria-label="Sample user">
              ET
            </span>
          </div>
          <p className={styles.disclosure}>
            This is a temporary demo. All listings and people are fictional. Edits stay in this page and reset
            on reload; use sample information only.
          </p>
          <p className={styles.notice} role="status" aria-live="polite">
            {notice}
          </p>
          {tab === "dashboard" && (
            <>
              <div className={styles.metrics}>
                {[
                  ["Sample contacts", metrics.contacts],
                  ["Open sample opportunities", metrics.opportunities],
                  ["Sample pipeline value", money(metrics.pipeline)],
                  ["Remaining sample tasks", metrics.tasks],
                ].map(([label, value]) => (
                  <section className={styles.metric} key={label}>
                    <p>{label}</p>
                    <strong>{value}</strong>
                    <span>Current preview data</span>
                  </section>
                ))}
              </div>
              <div className={styles.columns}>
                <section className={styles.card}>
                  <div className={styles.cardHeading}>
                    <h2>Your next steps</h2>
                    <Button variant="quiet" onClick={() => setTab("tasks")}>
                      View tasks <ArrowRight size={15} aria-hidden="true" />
                    </Button>
                  </div>
                  {tasks
                    .filter((task) => !task.done)
                    .map((task) => (
                      <div className={styles.task} key={task.id}>
                        <CheckCircle2 size={21} aria-hidden="true" />
                        <span>{task.title}</span>
                      </div>
                    ))}
                  {metrics.tasks === 0 && <p>Every sample task is complete.</p>}
                </section>
                <section className={`${styles.card} ${styles.welcome}`}>
                  <House size={30} aria-hidden="true" />
                  <h2>Make room for your next chapter</h2>
                  <p>Explore the property experience, then try a website or message draft.</p>
                  <Button onClick={() => setTab("properties")}>
                    Explore sample homes <ArrowRight size={16} aria-hidden="true" />
                  </Button>
                </section>
              </div>
              <section className={styles.card}>
                <h2>Sample pipeline</h2>
                <div className={styles.pipeline}>
                  {stages.map((stage) => (
                    <div key={stage}>
                      <span>{stage}</span>
                      <strong>{contacts.filter((contact) => contact.stage === stage).length}</strong>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
          {tab === "contacts" && (
            <>
              <section className={styles.card}>
                <h2>Add a fictional contact</h2>
                <form
                  className={styles.contactForm}
                  onSubmit={(event) => {
                    event.preventDefault();
                    try {
                      setContacts(addDemoContact(contacts, name, interest, crypto.randomUUID()));
                      setName("");
                      setInterest("");
                      changed();
                      setNotice("Contact added to this preview only.");
                    } catch (error) {
                      setNotice((error as Error).message);
                    }
                  }}
                >
                  <label>
                    Sample name
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={80}
                      required
                      placeholder="Casey Sample"
                    />
                  </label>
                  <label>
                    Home preferences
                    <input
                      value={interest}
                      onChange={(event) => setInterest(event.target.value)}
                      maxLength={160}
                      placeholder="Summerlin · 3 bedrooms"
                    />
                  </label>
                  <Button type="submit">
                    <Plus size={16} aria-hidden="true" /> Add sample contact
                  </Button>
                </form>
              </section>
              <section className={styles.card}>
                <div className={styles.cardHeading}>
                  <h2>Contacts & pipeline</h2>
                  <label className={styles.search}>
                    <Search size={18} aria-hidden="true" />
                    <input
                      aria-label="Search sample contacts"
                      placeholder="Search contacts"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                </div>
                <div className={styles.tableWrap}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Contact</th>
                        <th scope="col">Preferences</th>
                        <th scope="col">Stage</th>
                        <th scope="col">Sample value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contacts
                        .filter((contact) =>
                          `${contact.name} ${contact.interest}`.toLowerCase().includes(search.toLowerCase()),
                        )
                        .map((contact) => (
                          <tr key={contact.id}>
                            <th scope="row">{contact.name}</th>
                            <td>{contact.interest}</td>
                            <td>
                              <select
                                aria-label={`Stage for ${contact.name}`}
                                value={contact.stage}
                                onChange={(event) => {
                                  setContacts(
                                    changeDemoStage(contacts, contact.id, event.target.value as Stage),
                                  );
                                  changed();
                                }}
                              >
                                {stages.map((stage) => (
                                  <option key={stage}>{stage}</option>
                                ))}
                              </select>
                            </td>
                            <td>{contact.value ? money(contact.value) : "Not assigned"}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {!contacts.some((contact) =>
                  `${contact.name} ${contact.interest}`.toLowerCase().includes(search.toLowerCase()),
                ) && <p>No sample contacts match your search.</p>}
              </section>
            </>
          )}
          {tab === "tasks" && (
            <section className={styles.card}>
              <h2>Keep your next steps visible</h2>
              <form
                className={styles.inlineForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (tasks.length >= 200) {
                    setNotice("The preview is limited to 200 tasks.");
                    return;
                  }
                  const title = taskTitle.trim();
                  if (!title) return;
                  setTasks([...tasks, { id: crypto.randomUUID(), title, done: false }]);
                  setTaskTitle("");
                  changed();
                  setNotice("Task added to this preview only.");
                }}
              >
                <label>
                  New sample task
                  <input
                    value={taskTitle}
                    onChange={(event) => setTaskTitle(event.target.value)}
                    maxLength={160}
                    required
                  />
                </label>
                <Button type="submit">
                  <Plus size={16} aria-hidden="true" /> Add task
                </Button>
              </form>
              {tasks.map((task) => (
                <label className={styles.task} key={task.id}>
                  <input
                    type="checkbox"
                    checked={task.done}
                    onChange={() => {
                      setTasks(
                        tasks.map((item) => (item.id === task.id ? { ...item, done: !item.done } : item)),
                      );
                      changed();
                    }}
                  />
                  <span className={task.done ? styles.done : ""}>{task.title}</span>
                </label>
              ))}
            </section>
          )}
          {tab === "properties" && (
            <>
              <div className={styles.cardHeading}>
                <p>Original sample illustrations and fictional homes. No MLS data.</p>
                <label>
                  Area{" "}
                  <select value={area} onChange={(event) => setArea(event.target.value)}>
                    {["All areas", "Summerlin", "Henderson", "Las Vegas"].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className={styles.listings}>
                {sampleListings
                  .filter((listing) => area === "All areas" || listing.area === area)
                  .map((listing) => (
                    <article className={styles.listing} key={listing.id}>
                      <div className={`${styles.illustration} ${styles[listing.tone]}`}>
                        <House size={82} strokeWidth={1.15} aria-hidden="true" />
                        <span>FICTIONAL PROPERTY</span>
                        <button
                          type="button"
                          aria-label={`${favorites.includes(listing.id) ? "Unsave" : "Save"} ${listing.title}`}
                          aria-pressed={favorites.includes(listing.id)}
                          onClick={() => {
                            setFavorites(
                              favorites.includes(listing.id)
                                ? favorites.filter((id) => id !== listing.id)
                                : [...favorites, listing.id],
                            );
                            changed();
                          }}
                        >
                          <Heart size={20} fill={favorites.includes(listing.id) ? "currentColor" : "none"} />
                        </button>
                      </div>
                      <div className={styles.listingBody}>
                        <strong>{money(listing.price)}</strong>
                        <h2>{listing.title}</h2>
                        <p>
                          {listing.area} · {listing.beds} beds · {listing.baths} baths ·{" "}
                          {listing.size.toLocaleString()} sq ft
                        </p>
                        <Button
                          variant="secondary"
                          onClick={() =>
                            setSelectedListing(selectedListing === listing.id ? null : listing.id)
                          }
                        >
                          {selectedListing === listing.id ? "Close details" : "View details"}
                        </Button>
                        {selectedListing === listing.id && (
                          <p className={styles.details}>
                            {listing.style}. A fictional example for exploring this workspace. No real
                            address, agent attribution, inquiry or tour booking is connected.
                          </p>
                        )}
                      </div>
                    </article>
                  ))}
              </div>
            </>
          )}
          {tab === "website" && (
            <div className={styles.columns}>
              <section className={styles.card}>
                <h2>Write your home page</h2>
                <form
                  className={styles.editor}
                  onSubmit={(event) => {
                    event.preventDefault();
                    setNotice("Website draft kept in this preview only. It has not been published.");
                  }}
                >
                  <label>
                    Headline
                    <input
                      value={headline}
                      onChange={(event) => {
                        setHeadline(event.target.value);
                        changed();
                      }}
                      maxLength={120}
                      required
                    />
                  </label>
                  <label>
                    Introduction
                    <textarea
                      value={description}
                      onChange={(event) => {
                        setDescription(event.target.value);
                        changed();
                      }}
                      maxLength={1000}
                      rows={5}
                    />
                  </label>
                  <Button type="submit">
                    <Check size={16} aria-hidden="true" /> Keep draft in preview
                  </Button>
                </form>
              </section>
              <section className={`${styles.card} ${styles.sitePreview}`} aria-label="Website draft preview">
                <p>Sample Real Estate Team</p>
                <House size={48} aria-hidden="true" />
                <h2>{headline}</h2>
                <p>{description}</p>
                <span className={styles.previewCta}>Explore your next chapter</span>
                <small>Unpublished preview · no public website</small>
              </section>
            </div>
          )}
          {tab === "messages" && (
            <div className={styles.columns}>
              <section className={styles.card}>
                <h2>Compose a sample email</h2>
                <form
                  className={styles.editor}
                  onSubmit={(event) => {
                    event.preventDefault();
                    setNotice("Message draft kept in this preview only. Nothing has been sent.");
                  }}
                >
                  <label>
                    Subject
                    <input
                      value={subject}
                      onChange={(event) => {
                        setSubject(event.target.value);
                        changed();
                      }}
                      maxLength={150}
                      required
                    />
                  </label>
                  <label>
                    Message
                    <textarea
                      value={message}
                      onChange={(event) => {
                        setMessage(event.target.value);
                        changed();
                      }}
                      maxLength={4000}
                      rows={9}
                      required
                    />
                  </label>
                  <Button type="submit">
                    <Check size={16} aria-hidden="true" /> Keep draft in preview
                  </Button>
                </form>
              </section>
              <section className={styles.card} aria-label="Message draft preview">
                <Badge>Draft · no delivery</Badge>
                <h2 className={styles.messageSubject}>{subject}</h2>
                <p className={styles.messageBody}>{message}</p>
              </section>
            </div>
          )}
          {tab === "install" && (
            <section className={styles.card}>
              <Smartphone size={36} aria-hidden="true" />
              <h2>Take the workspace with you</h2>
              <p className={styles.installText}>
                Use this preview on iPhone or Android without an app store. Installation requires HTTPS. The
                preview password still applies, and temporary edits reset when the page reloads.
              </p>
              {install && (
                <Button
                  onClick={async () => {
                    await install.prompt();
                    await install.userChoice;
                    setInstall(null);
                  }}
                >
                  Install preview
                </Button>
              )}
              <div className={styles.columns}>
                <div>
                  <h3>iPhone · Safari</h3>
                  <ol>
                    <li>Open this site in Safari.</li>
                    <li>Tap Share, then Add to Home Screen.</li>
                    <li>Tap Add and open Estate from your home screen.</li>
                  </ol>
                </div>
                <div>
                  <h3>Android · Chrome</h3>
                  <ol>
                    <li>Open this site in Chrome.</li>
                    <li>Tap the browser menu, then Install app or Add to Home screen.</li>
                    <li>Open Estate from your home screen.</li>
                  </ol>
                </div>
              </div>
              <p>Offline access shows a generic connection screen. Private pages and edits are not cached.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
