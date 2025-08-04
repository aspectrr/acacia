import React, { useState, useEffect } from "react";
import {
  Play,
  Save,
  Trash2,
  Edit3,
  Code,
  Database,
  Zap,
  Plus,
  Eye,
  Settings,
  BarChart,
} from "lucide-react";

interface Extension {
  id: string;
  name: string;
  description: string;
  code: string;
  enabled: boolean;
  version: number;
  routes: ExtensionRoute[];
  createdAt: string;
  updatedAt: string;
}

interface ExtensionRoute {
  id: string;
  method: string;
  pathPattern: string;
  patternType: "exact" | "prefix" | "regex";
  executionType: "before" | "after" | "replace";
  priority: number;
}

interface ApiEndpoint {
  id: number;
  method: string;
  path: string;
  hitCount: number;
  lastSeen: string;
  sampleRequest?: any;
  sampleResponse?: any;
}

export default function ExtensionManagement() {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [apiEndpoints, setApiEndpoints] = useState<ApiEndpoint[]>([]);
  const [selectedExtension, setSelectedExtension] = useState<Extension | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<
    "extensions" | "api-discovery" | "create"
  >("extensions");
  const [isCreating, setIsCreating] = useState(false);

  // Mock data for demo
  useEffect(() => {
    setExtensions([
      {
        id: "1",
        name: "AI Lead Scorer",
        description:
          "Automatically scores leads based on profile data and engagement",
        code: `// Add AI lead scoring to user objects
const response = await response.json();
if (Array.isArray(response.users)) {
  response.users.forEach(user => {
    user.aiScore = calculateLeadScore(user);
    user.scoreReason = getScoreExplanation(user);
  });
}
return new Response(JSON.stringify(response));`,
        enabled: true,
        version: 3,
        routes: [
          {
            id: "1",
            method: "GET",
            pathPattern: "/api/users",
            patternType: "exact",
            executionType: "after",
            priority: 1,
          },
        ],
        createdAt: "2024-01-15T10:30:00Z",
        updatedAt: "2024-01-20T14:22:00Z",
      },
      {
        id: "2",
        name: "Email Template Generator",
        description:
          "Generates personalized email templates for customer outreach",
        code: `// Generate personalized email templates
const data = await request.json();
data.emailTemplate = await generatePersonalizedEmail(data.customer);
data.suggestedSubject = generateSubjectLine(data.customer);
return new Request(request.url, {
  ...request,
  body: JSON.stringify(data)
});`,
        enabled: true,
        version: 1,
        routes: [
          {
            id: "2",
            method: "POST",
            pathPattern: "/api/emails/compose",
            patternType: "exact",
            executionType: "before",
            priority: 1,
          },
        ],
        createdAt: "2024-01-18T09:15:00Z",
        updatedAt: "2024-01-18T09:15:00Z",
      },
    ]);

    setApiEndpoints([
      {
        id: 1,
        method: "GET",
        path: "/api/users",
        hitCount: 342,
        lastSeen: "2024-01-20T15:30:00Z",
        sampleResponse: {
          users: [{ id: 1, name: "John Doe", email: "john@example.com" }],
        },
      },
      {
        id: 2,
        method: "POST",
        path: "/api/emails/compose",
        hitCount: 89,
        lastSeen: "2024-01-20T14:45:00Z",
        sampleRequest: { customer: { id: 1 }, subject: "Follow up" },
      },
      {
        id: 3,
        method: "GET",
        path: "/api/dashboard/stats",
        hitCount: 156,
        lastSeen: "2024-01-20T15:28:00Z",
      },
    ]);
  }, []);

  const ExtensionCard = ({ extension }: { extension: Extension }) => (
    <div className="bg-white rounded-lg border border-gray-200 hover:border-gray-300 transition-colors">
      <div className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h3 className="font-semibold text-gray-900">{extension.name}</h3>
              <span
                className={`px-2 py-1 rounded-full text-xs font-medium ${
                  extension.enabled
                    ? "bg-green-100 text-green-800"
                    : "bg-gray-100 text-gray-600"
                }`}
              >
                {extension.enabled ? "Active" : "Disabled"}
              </span>
              <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded-full text-xs font-medium">
                v{extension.version}
              </span>
            </div>
            <p className="text-gray-600 text-sm mb-4">
              {extension.description}
            </p>

            <div className="flex items-center gap-4 text-sm text-gray-500">
              <span>
                {extension.routes.length} route
                {extension.routes.length !== 1 ? "s" : ""}
              </span>
              <span>
                Updated {new Date(extension.updatedAt).toLocaleDateString()}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 ml-4">
            <button
              onClick={() => setSelectedExtension(extension)}
              className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
              title="View/Edit"
            >
              <Edit3 size={16} />
            </button>
            <button
              className="p-2 text-gray-500 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors"
              title="Test"
            >
              <Play size={16} />
            </button>
            <button
              className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              title="Delete"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-gray-100">
          <div className="flex flex-wrap gap-2">
            {extension.routes.map((route) => (
              <span
                key={route.id}
                className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 rounded text-xs"
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    route.method === "GET"
                      ? "bg-green-500"
                      : route.method === "POST"
                        ? "bg-blue-500"
                        : "bg-orange-500"
                  }`}
                ></span>
                {route.method} {route.pathPattern}
                <span className="text-gray-500">({route.executionType})</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const ExtensionEditor = ({ extension }: { extension: Extension }) => {
    const [editedExtension, setEditedExtension] = useState(extension);
    const [activeEditorTab, setActiveEditorTab] = useState<
      "code" | "routes" | "test"
    >("code");

    return (
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{extension.name}</h2>
            <div className="flex items-center gap-3">
              <button className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm">
                <Save size={14} className="inline mr-1" />
                Save
              </button>
              <button
                onClick={() => setSelectedExtension(null)}
                className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm"
              >
                Close
              </button>
            </div>
          </div>

          <div className="flex gap-1 mt-4">
            {[
              { id: "code", label: "Code", icon: Code },
              { id: "routes", label: "Routes", icon: Settings },
              { id: "test", label: "Test", icon: Play },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveEditorTab(tab.id as any)}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
                  activeEditorTab === tab.id
                    ? "bg-blue-100 text-blue-700"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                <tab.icon size={14} />
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6">
          {activeEditorTab === "code" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Extension Code
              </label>
              <textarea
                value={editedExtension.code}
                onChange={(e) =>
                  setEditedExtension({
                    ...editedExtension,
                    code: e.target.value,
                  })
                }
                className="w-full h-64 font-mono text-sm border border-gray-300 rounded-lg p-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Write your extension code here..."
              />
              <p className="mt-2 text-xs text-gray-500">
                Your code will receive <code>request</code> and{" "}
                <code>response</code> parameters depending on the execution
                type.
              </p>
            </div>
          )}

          {activeEditorTab === "routes" && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium">Route Configuration</h3>
                <button className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm">
                  <Plus size={14} className="inline mr-1" />
                  Add Route
                </button>
              </div>

              <div className="space-y-4">
                {editedExtension.routes.map((route) => (
                  <div
                    key={route.id}
                    className="border border-gray-200 rounded-lg p-4"
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Method
                        </label>
                        <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                          <option value="GET">GET</option>
                          <option value="POST">POST</option>
                          <option value="PUT">PUT</option>
                          <option value="DELETE">DELETE</option>
                          <option value="*">All Methods</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Path Pattern
                        </label>
                        <input
                          type="text"
                          value={route.pathPattern}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                          placeholder="/api/users"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Pattern Type
                        </label>
                        <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                          <option value="exact">Exact Match</option>
                          <option value="prefix">Prefix Match</option>
                          <option value="regex">Regular Expression</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Execution Type
                        </label>
                        <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                          <option value="before">
                            Before (Modify Request)
                          </option>
                          <option value="after">After (Modify Response)</option>
                          <option value="replace">
                            Replace (New Endpoint)
                          </option>
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeEditorTab === "test" && (
            <div>
              <h3 className="font-medium mb-4">Test Extension</h3>
              <div className="bg-gray-50 rounded-lg p-4 mb-4">
                <div className="flex items-center gap-2 mb-3">
                  <Zap size={16} className="text-blue-600" />
                  <span className="font-medium text-sm">Quick Test</span>
                </div>
                <p className="text-sm text-gray-600 mb-3">
                  Test your extension against sample data from discovered API
                  endpoints.
                </p>
                <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm">
                  Run Test
                </button>
              </div>

              <div className="border border-gray-200 rounded-lg p-4">
                <h4 className="font-medium text-sm mb-3">Test Results</h4>
                <div className="bg-green-50 border border-green-200 rounded p-3 text-sm">
                  <div className="text-green-800 font-medium mb-1">
                    ✓ Test passed
                  </div>
                  <div className="text-green-700">
                    Extension executed successfully in 23ms
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const ApiDiscoveryTab = () => (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-2">API Discovery</h2>
        <p className="text-gray-600">
          Automatically discovered endpoints from your application traffic.
        </p>
      </div>

      <div className="grid gap-4">
        {apiEndpoints.map((endpoint) => (
          <div
            key={endpoint.id}
            className="bg-white rounded-lg border border-gray-200 p-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span
                  className={`px-2 py-1 rounded text-xs font-medium ${
                    endpoint.method === "GET"
                      ? "bg-green-100 text-green-800"
                      : endpoint.method === "POST"
                        ? "bg-blue-100 text-blue-800"
                        : "bg-orange-100 text-orange-800"
                  }`}
                >
                  {endpoint.method}
                </span>
                <code className="font-mono text-sm">{endpoint.path}</code>
              </div>

              <div className="flex items-center gap-4 text-sm text-gray-500">
                <div className="flex items-center gap-1">
                  <BarChart size={14} />
                  {endpoint.hitCount} hits
                </div>
                <span>
                  Last seen {new Date(endpoint.lastSeen).toLocaleDateString()}
                </span>
                <button className="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 transition-colors">
                  Create Extension
                </button>
              </div>
            </div>

            {(endpoint.sampleRequest || endpoint.sampleResponse) && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <div className="grid grid-cols-2 gap-4 text-xs">
                  {endpoint.sampleRequest && (
                    <div>
                      <div className="font-medium text-gray-700 mb-1">
                        Sample Request
                      </div>
                      <pre className="bg-gray-50 p-2 rounded overflow-x-auto">
                        {JSON.stringify(endpoint.sampleRequest, null, 2)}
                      </pre>
                    </div>
                  )}
                  {endpoint.sampleResponse && (
                    <div>
                      <div className="font-medium text-gray-700 mb-1">
                        Sample Response
                      </div>
                      <pre className="bg-gray-50 p-2 rounded overflow-x-auto">
                        {JSON.stringify(endpoint.sampleResponse, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="border-b border-gray-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                Extension Manager
              </h1>
              <p className="text-gray-600 mt-1">
                Create and manage custom extensions for your application
              </p>
            </div>

            <button
              onClick={() => setActiveTab("create")}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
            >
              <Plus size={16} />
              New Extension
            </button>
          </div>

          <div className="flex gap-1 mt-6">
            {[
              { id: "extensions", label: "Extensions", icon: Code },
              { id: "api-discovery", label: "API Discovery", icon: Database },
              { id: "create", label: "Create New", icon: Plus },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                  activeTab === tab.id
                    ? "bg-blue-100 text-blue-700"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                <tab.icon size={16} />
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {selectedExtension ? (
          <ExtensionEditor extension={selectedExtension} />
        ) : (
          <>
            {activeTab === "extensions" && (
              <div>
                <div className="grid gap-6">
                  {extensions.map((extension) => (
                    <ExtensionCard key={extension.id} extension={extension} />
                  ))}
                </div>
              </div>
            )}

            {activeTab === "api-discovery" && <ApiDiscoveryTab />}

            {activeTab === "create" && (
              <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
                <div className="max-w-md mx-auto">
                  <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Plus size={32} className="text-blue-600" />
                  </div>
                  <h2 className="text-xl font-semibold mb-2">
                    Create New Extension
                  </h2>
                  <p className="text-gray-600 mb-6">
                    Build custom functionality for your application with AI
                    assistance or from scratch.
                  </p>

                  <div className="space-y-3">
                    <button className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2">
                      <Zap size={16} />
                      Generate with AI
                    </button>
                    <button className="w-full px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors flex items-center justify-center gap-2">
                      <Code size={16} />
                      Start from Template
                    </button>
                    <button className="w-full px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors flex items-center justify-center gap-2">
                      <Edit3 size={16} />
                      Build from Scratch
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
