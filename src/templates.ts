import type { DiagramKind } from "./model/types";
import type { MessageKey } from "./i18n";

export interface Template {
  id: string;
  kind: DiagramKind;
  nameKey: MessageKey;
  descriptionKey: MessageKey;
  code: string;
}

/**
 * Starting points that show what each diagram family is *for*.
 *
 * `NEW_DIAGRAM` in the store gives two-node stubs, which prove nothing: a new
 * user sees an empty canvas and has to already know the syntax. These are
 * small but complete — recognisable shapes a reader can edit into their own
 * case rather than build from nothing.
 *
 * Deliberately no `%% graph:positions` line: these lay out with ELK on open,
 * so they look right at any window size instead of carrying coordinates
 * chosen on somebody else's screen.
 */
export const TEMPLATES: Template[] = [
  {
    id: "approval",
    kind: "flowchart",
    nameKey: "tpl.approval",
    descriptionKey: "tpl.approvalDesc",
    code: `flowchart TD
  submit[/"Submit request"/]
  review{"Manager approves?"}
  budget{"Over budget?"}
  finance["Finance review"]
  approved(["Approved"])
  rejected(["Rejected"])

  submit --> review
  review -->|"yes"| budget
  review -->|"no"| rejected
  budget -->|"yes"| finance
  budget -->|"no"| approved
  finance -->|"signed off"| approved
  finance -->|"declined"| rejected
`,
  },
  {
    id: "auth",
    kind: "sequence",
    nameKey: "tpl.auth",
    descriptionKey: "tpl.authDesc",
    code: `sequenceDiagram
  actor U as User
  participant A as App
  participant S as Auth service
  participant D as Database

  U->>A: Sign in
  A->>S: POST /token
  S->>D: Look up account
  D-->>S: Account
  alt credentials valid
    S-->>A: Access token
    A-->>U: Signed in
  else invalid
    S-->>A: 401
    A-->>U: Show error
  end
`,
  },
  {
    id: "orders",
    kind: "er",
    nameKey: "tpl.orders",
    descriptionKey: "tpl.ordersDesc",
    code: `erDiagram
  CUSTOMER {
    string id PK
    string email "unique"
    string name
  }
  ORDER {
    string id PK
    string customer_id FK
    date placed_at
    string status
  }
  LINE_ITEM {
    string id PK
    string order_id FK
    int quantity
  }
  PRODUCT {
    string sku PK
    string name
    decimal price
  }

  CUSTOMER ||--o{ ORDER : "places"
  ORDER ||--|{ LINE_ITEM : "contains"
  PRODUCT ||--o{ LINE_ITEM : "appears in"
`,
  },
  {
    id: "webapp",
    kind: "architecture",
    nameKey: "tpl.webapp",
    descriptionKey: "tpl.webappDesc",
    code: `architecture-beta
  group cloud(cloud)[Cloud]
  group data(database)[Data] in cloud

  service users(internet)[Users]
  service cdn(server)[CDN] in cloud
  service api(server)[API] in cloud
  service db(database)[Postgres] in data
  service cache(disk)[Redis] in data

  users:R --> L:cdn
  cdn:R --> L:api
  api:R --> L:db
  api:B --> T:cache
`,
  },
  {
    id: "order-state",
    kind: "state",
    nameKey: "tpl.orderState",
    descriptionKey: "tpl.orderStateDesc",
    code: `stateDiagram-v2
  [*] --> Draft
  Draft --> Submitted : submit
  Submitted --> Paid : payment cleared
  Submitted --> Cancelled : cancel
  Paid --> Shipped : dispatch
  Shipped --> Delivered : signed for
  Delivered --> [*]
  Cancelled --> [*]
`,
  },
  {
    id: "domain",
    kind: "class",
    nameKey: "tpl.domain",
    descriptionKey: "tpl.domainDesc",
    code: `classDiagram
  class Account {
    +string id
    +string email
    +suspend() void
  }
  class Subscription {
    +string plan
    +date renewsAt
    +cancel() void
  }
  class Invoice {
    +decimal total
    +bool paid
  }

  Account "1" --> "0..*" Subscription : has
  Subscription "1" --> "0..*" Invoice : bills
`,
  },
  {
    id: "context",
    kind: "c4",
    nameKey: "tpl.context",
    descriptionKey: "tpl.contextDesc",
    code: `C4Context
  title System context

  Person(customer, "Customer", "Places orders")
  Person(staff, "Support agent", "Handles queries")
  System(shop, "Shop", "Storefront and checkout")
  System_Ext(payments, "Payment provider", "Card processing")
  System_Ext(email, "Email service", "Transactional mail")

  Rel(customer, shop, "Browses and buys")
  Rel(staff, shop, "Looks up orders")
  Rel(shop, payments, "Charges cards", "HTTPS")
  Rel(shop, email, "Sends receipts", "SMTP")
`,
  },

  /*
   * SysML. Four views of one system — a small drone — so that together they
   * read as a model rather than as four unrelated pictures: what it must do,
   * what it is made of, the modes it runs in, and how a mission runs.
   *
   * Only the requirement diagram is a SysML family in mermaid. The other three
   * are SysML notation written in the UML family that draws it: a block
   * definition diagram is a class diagram of «block»s, a state machine is a
   * state diagram, an activity is a flowchart with SysML's initial and final
   * nodes. They are edited exactly as those families are.
   */
  {
    id: "sysml-requirements",
    kind: "requirement",
    nameKey: "tpl.sysmlRequirements",
    descriptionKey: "tpl.sysmlRequirementsDesc",
    code: `requirementDiagram
  requirement mission {
    id: "R-0"
    text: "The drone shall survey a 2 km route and come back unaided."
    risk: medium
    verifymethod: demonstration
  }
  performanceRequirement flight_time {
    id: "R-1"
    text: "The drone shall fly for at least 30 minutes on one charge."
    risk: high
    verifymethod: test
  }
  functionalRequirement return_home {
    id: "R-2"
    text: "The drone shall return home when the battery falls below 15%."
    risk: high
    verifymethod: test
  }
  physicalRequirement takeoff_mass {
    id: "R-1.1"
    text: "The take-off mass shall not exceed 2 kg."
    risk: medium
    verifymethod: inspection
  }
  element battery_pack {
    type: "block"
  }
  element flight_controller {
    type: "block"
  }
  element endurance_test {
    type: "test case"
  }

  mission - contains -> flight_time
  mission - contains -> return_home
  takeoff_mass - derives -> flight_time
  battery_pack - satisfies -> flight_time
  flight_controller - satisfies -> return_home
  endurance_test - verifies -> flight_time
`,
  },
  {
    id: "sysml-bdd",
    kind: "class",
    nameKey: "tpl.sysmlBdd",
    descriptionKey: "tpl.sysmlBddDesc",
    code: `classDiagram
  class Drone {
    <<block>>
    part frame : Airframe
    part power : BatteryPack
    part rotors : Rotor
    value mass : kg
  }
  class Airframe {
    <<block>>
    value material : String
  }
  class BatteryPack {
    <<block>>
    value capacity : Wh
    port charge : DCPort
  }
  class Rotor {
    <<block>>
    value diameter : mm
    spin(rpm : Real) void
  }

  Drone *-- "1" Airframe : frame
  Drone *-- "1" BatteryPack : power
  Drone *-- "4" Rotor : rotors
`,
  },
  {
    id: "sysml-state-machine",
    kind: "state",
    nameKey: "tpl.sysmlStateMachine",
    descriptionKey: "tpl.sysmlStateMachineDesc",
    code: `stateDiagram-v2
  [*] --> Off
  Off --> Standby : power on
  Standby --> Off : power off
  Standby --> Flying : arm and launch
  state Flying {
    [*] --> TakingOff
    TakingOff --> Cruising : altitude reached
    Cruising --> Hovering : waypoint reached
    Hovering --> [*] : survey done
  }
  Flying --> Landing : low battery
  Landing --> Standby : touched down
`,
  },
  {
    id: "sysml-activity",
    kind: "flowchart",
    nameKey: "tpl.sysmlActivity",
    descriptionKey: "tpl.sysmlActivityDesc",
    code: `flowchart LR
  initial(("Start"))
  plan("Receive mission plan")
  charged{"Battery above 30%?"}
  charge("Charge battery")
  merge{"merge"}
  checks("Run pre-flight checks")
  fly("Fly the route")
  final((("End")))

  initial --> plan
  plan --> charged
  charged -->|"no"| charge
  charged -->|"yes"| merge
  charge --> merge
  merge --> checks
  checks --> fly
  fly --> final
`,
  },
];
