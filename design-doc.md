Here is a comprehensive software design document detailing the architecture, components, and workflows. Following the document, I have included the requested repository URLs for Claude Code skills and Model Context Protocol (MCP) servers to help you build this stack.

# **Design Document: WoW Active Progression Engine**

## **1\. Overview and Objective**

**Objective:** Build a web-based, active-learning diagnostic tool to help Mythic World of Warcraft raiding guilds transition from lower-tier Cutting Edge (CE) to Hall of Fame (HOF) performance levels.  
**Methodology:** The system will move beyond passive data visualization by programmatically ingesting written class/encounter guides (e.g., Wowhead), converting them into strict logic rulebooks via an LLM, and evaluating high-fidelity Warcraft Logs (WCL) telemetry against those rules to provide prescriptive, actionable feedback.

## **2\. Proposed Technology Stack**

To give Claude Code a solid foundation, the following modern tech stack is recommended:

* **Frontend:** Next.js (React) styled with Tailwind CSS for a highly responsive, single-page application dashboard.  
* **Backend:** Python (FastAPI) to handle the complex data parsing, API orchestration, and LLM processing workflows.  
* **Database:** PostgreSQL for storing user profiles, parsed LLM rulebooks, and historical pull data.  
* **External APIs:** Warcraft Logs API v2 (GraphQL) , OpenAI/Anthropic API (for guide ingestion).

## **3\. System Architecture & Components**

The architecture is divided into three primary micro-services/modules:

### **A. The Knowledge Ingestion Service (Python/LLM)**

This service is responsible for keeping the tool up to date without manual hardcoding.

* **Input:** URLs from Wowhead class guides or raid encounter guides.  
* **Process:** A web scraper extracts the text. An LLM parses the unstructured text to identify core rotational priorities (e.g., buff uptimes, cooldown stacking requirements, maximum resource caps).  
* **Output:** A deterministic JSON "Rulebook" saved to the PostgreSQL database, representing the absolute mathematical ideal for a specific specialization on a specific patch.

### **B. The Telemetry Extraction Pipeline (Python)**

This service fetches the raw combat data.

* **Input:** A user submits a Warcraft Logs report URL/ID to the Next.js frontend.  
* **Process:** The Python backend executes a GraphQL query against the Warcraft Logs API v2, extracting the reportData, specific fights, and the millisecond-by-millisecond events array filtered by the player's ID. It also pulls X/Y positional coordinate data.

* **Output:** A normalized chronological timeline of every cast, buff, resource generation, and movement event the player executed.

### **C. The Analytical Rules Engine (Python)**

This is the core logic processor.

* **Process:** The engine loads the LLM-generated JSON "Rulebook" from the database and overlays it onto the player's WCL event timeline. It checks for specific infractions (e.g., "Did the player cast *Avenging Wrath* without *Execution Sentence*?").  
* **Output:** A structured array of "Anomalies" or "Errors" categorized by severity (Critical Failure, Efficiency Loss, Positional Error). This array is sent back to the Next.js frontend to be displayed as natural-language, prescriptive feedback.

## **4\. Core User Workflows**

### **Workflow 1: System Admin Guide Ingestion (Triggered per Patch/Tier)**

1. Admin inputs Wowhead guide URLs into the backend UI.  
2. Python script scrapes the text and passes it to the LLM with a strict system prompt.  
3. LLM outputs a JSON Rulebook.  
4. Python validates the JSON format and saves it to the PostgreSQL database under the current patch version.

### **Workflow 2: Player Post-Pull Analysis**

1. Player finishes a raid wipe and pastes the Warcraft Logs URL into the Next.js web application.  
2. Next.js sends the ID to the FastAPI backend.  
3. Backend queries the WCL GraphQL API for the player's event timeline.

4. Backend queries PostgreSQL for the player's current spec Rulebook.  
5. Analytical Engine compares the timeline against the Rulebook, generating a list of actionable faults.  
6. Backend queries the WCL API for the top 50 parses (similar to Lorrgs.io logic) to find the median optimal cast time for the missed cooldowns.

7. Frontend renders the feedback: *"Critical Failure (04:12): You delayed your major cooldown by 15s. Top players cast this at 04:00 to align with the final Bloodlust window."*

### **Workflow 3: VOD Synchronization (Future Implementation)**

1. Player links their local video file recorded via Warcraft Recorder (which already splits videos by combat log pull triggers).

2. When the Analytical Engine flags an error at timestamp 04:12, the frontend creates a clickable deep-link.  
3. Clicking the link scrubs the local video player exactly to 04:07 (5 seconds prior to the error) so the player can see their positioning and UI state at the exact moment the mistake occurred.

## **5\. Resources & Claude Skills for Development**

To help Claude Code build this specific architecture, you can install the following skills and Model Context Protocol (MCP) servers into your environment.  
**For Next.js / Web Development:**

* **Claude Next.js Skills:** You can point Claude to the repository located at https://github.com/wsimmonds/claude-nextjs-skills, which contains skills specifically designed to help Claude write compliant, up-to-date Next.js application code.

**For General Engineering & Architecture:**

* **Claude Skills Hub:** The repository at https://github.com/alirezarezvani/claude-skills is a massive library containing over 300 installable skills. You can use the command /plugin install engineering-skills@claude-code-skills within Claude Code to equip it with core engineering, Python, and architecture capabilities.

**For Database Integration (PostgreSQL):**  
Claude Code utilizes Model Context Protocol (MCP) servers to interact securely with databases, allowing it to inspect schemas and write queries during development.

* **PostgreSQL MCP (Official/Standard):** You can install the PostgreSQL MCP server found at https://mcpservers.org/servers/udaykumar-dhokia/postgresql-mcp.git. This gives Claude tools to create\_table, list\_tables, and execute\_sql directly.  
* **Postgres MCP Pro:** For a more advanced setup that includes performance analysis and execution plan tools, you can point Claude to https://github.com/crystaldba/postgres-mcp.