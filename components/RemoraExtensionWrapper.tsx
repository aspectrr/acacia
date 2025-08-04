import React, { useState, useEffect, useRef } from "react";

interface ExtensionWrapperProps {
  children: React.ReactElement;
  data?: any;
  className?: string;
  showExtensionFields?: boolean;
  extensionFieldsPosition?: "top" | "bottom" | "side";
}

interface ExtensionField {
  key: string;
  value: any;
  type: string;
}

export default function ExtensionWrapper({
  children,
  data = {},
  className = "",
  showExtensionFields = true,
  extensionFieldsPosition = "bottom",
}: ExtensionWrapperProps) {
  const [extensionFields, setExtensionFields] = useState<ExtensionField[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const childRef = useRef<HTMLDivElement>(null);
  const originalPropsRef = useRef<any>(null);

  // Ensure children exists and extract props safely
  if (!children) {
    return (
      <div className="text-red-500">
        ExtensionWrapper: No child component provided
      </div>
    );
  }

  // Extract props from the child component
  const childProps = children?.props || {};
  const combinedData = { ...childProps, ...data };

  useEffect(() => {
    if (!showExtensionFields || !combinedData) return;

    // Store original props for comparison
    originalPropsRef.current = combinedData;

    // Analyze what fields the child component actually renders
    analyzeRenderedFields();
  }, [combinedData, showExtensionFields]);

  const analyzeRenderedFields = () => {
    setIsAnalyzing(true);

    // Get all the data passed to the component
    const allFields = flattenObject(combinedData);

    // Simulate checking what the child component renders
    // In a real implementation, you might use DOM analysis or other techniques
    setTimeout(() => {
      const renderedFields = findUnrenderedFields(allFields);
      setExtensionFields(renderedFields);
      setIsAnalyzing(false);
    }, 100);
  };

  // Flatten nested objects to find all available fields
  const flattenObject = (obj: any, prefix = ""): Record<string, any> => {
    const flattened: Record<string, any> = {};

    if (!obj || typeof obj !== "object") return flattened;

    Object.keys(obj).forEach((key) => {
      const value = obj[key];
      const newKey = prefix ? `${prefix}.${key}` : key;

      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date)
      ) {
        Object.assign(flattened, flattenObject(value, newKey));
      } else {
        flattened[newKey] = value;
      }
    });

    return flattened;
  };

  // Identify fields that might be extension-added (heuristic approach)
  const findUnrenderedFields = (
    allFields: Record<string, any>,
  ): ExtensionField[] => {
    const potentialExtensionFields: ExtensionField[] = [];

    // Look for fields that seem like they were added by extensions
    Object.entries(allFields).forEach(([key, value]) => {
      // Skip common React/HTML props
      if (isCommonProp(key)) return;

      // Skip null/undefined values
      if (value == null) return;

      // Look for extension-specific patterns
      if (isLikelyExtensionField(key, value)) {
        potentialExtensionFields.push({
          key,
          value,
          type: getFieldType(value),
        });
      }
    });

    return potentialExtensionFields;
  };

  const isCommonProp = (key: string): boolean => {
    const commonProps = [
      "children",
      "className",
      "style",
      "id",
      "key",
      "ref",
      "onClick",
      "onChange",
      "onSubmit",
      "onFocus",
      "onBlur",
      "data-",
      "aria-",
      "role",
      "tabIndex",
    ];

    return commonProps.some((prop) => key === prop || key.startsWith(prop));
  };

  const isLikelyExtensionField = (key: string, value: any): boolean => {
    // Look for extension patterns
    const extensionPatterns = [
      /extension/i,
      /ai/i,
      /generated/i,
      /computed/i,
      /enhanced/i,
      /score/i,
      /rating/i,
      /analysis/i,
      /metadata/i,
    ];

    // Check if key matches extension patterns
    if (extensionPatterns.some((pattern) => pattern.test(key))) {
      return true;
    }

    // Check if value has extension-like structure
    if (typeof value === "object" && value !== null) {
      if (value.source === "extension-proxy" || value.generatedBy) {
        return true;
      }
    }

    // Check for fields with timestamps that might be extension-added
    if (key.includes("At") || key.includes("Time")) {
      return true;
    }

    return false;
  };

  const getFieldType = (value: any): string => {
    if (typeof value === "string") return "string";
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";
    if (Array.isArray(value)) return "array";
    if (value instanceof Date) return "date";
    if (typeof value === "object") return "object";
    return "unknown";
  };

  const renderExtensionField = (field: ExtensionField) => {
    const { key, value, type } = field;

    const baseClasses = "px-2 py-1 rounded text-sm";

    switch (type) {
      case "string":
        return (
          <div
            key={key}
            className={`${baseClasses} bg-blue-50 border border-blue-200`}
          >
            <span className="font-medium text-blue-800">
              {formatFieldName(key)}:
            </span>
            <span className="ml-2 text-blue-600">{value}</span>
          </div>
        );

      case "number":
        return (
          <div
            key={key}
            className={`${baseClasses} bg-green-50 border border-green-200`}
          >
            <span className="font-medium text-green-800">
              {formatFieldName(key)}:
            </span>
            <span className="ml-2 text-green-600 font-mono">{value}</span>
          </div>
        );

      case "boolean":
        return (
          <div
            key={key}
            className={`${baseClasses} bg-purple-50 border border-purple-200`}
          >
            <span className="font-medium text-purple-800">
              {formatFieldName(key)}:
            </span>
            <span
              className={`ml-2 px-1 py-0.5 rounded text-xs ${
                value
                  ? "bg-green-100 text-green-800"
                  : "bg-red-100 text-red-800"
              }`}
            >
              {value ? "Yes" : "No"}
            </span>
          </div>
        );

      case "array":
        return (
          <div
            key={key}
            className={`${baseClasses} bg-orange-50 border border-orange-200`}
          >
            <span className="font-medium text-orange-800">
              {formatFieldName(key)}:
            </span>
            <span className="ml-2 text-orange-600">
              [{Array.isArray(value) ? value.length : 0} items]
            </span>
          </div>
        );

      case "object":
        return (
          <div
            key={key}
            className={`${baseClasses} bg-gray-50 border border-gray-200`}
          >
            <span className="font-medium text-gray-800">
              {formatFieldName(key)}:
            </span>
            <div className="ml-2 mt-1 text-xs text-gray-600 font-mono">
              {JSON.stringify(value, null, 2)}
            </div>
          </div>
        );

      default:
        return (
          <div
            key={key}
            className={`${baseClasses} bg-gray-50 border border-gray-200`}
          >
            <span className="font-medium text-gray-800">
              {formatFieldName(key)}:
            </span>
            <span className="ml-2 text-gray-600">{String(value)}</span>
          </div>
        );
    }
  };

  const formatFieldName = (key: string): string => {
    return (
      key
        .split(".")
        .pop()
        ?.replace(/([A-Z])/g, " $1")
        .replace(/^./, (str) => str.toUpperCase()) || key
    );
  };

  const renderExtensionFields = () => {
    if (!showExtensionFields || extensionFields.length === 0) return null;

    return (
      <div className="extension-fields border-t border-gray-200 pt-3 mt-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
          <span className="text-xs font-medium text-gray-600 uppercase tracking-wide">
            Extension Fields
          </span>
        </div>
        <div className="space-y-2">
          {extensionFields.map(renderExtensionField)}
        </div>
        {isAnalyzing && (
          <div className="text-xs text-gray-500 mt-2 flex items-center gap-1">
            <div className="w-3 h-3 border border-gray-300 border-t-blue-500 rounded-full animate-spin"></div>
            Analyzing extension data...
          </div>
        )}
      </div>
    );
  };

  const wrapperClass = `extension-wrapper ${className}`;

  if (extensionFieldsPosition === "side") {
    return (
      <div className={`${wrapperClass} flex gap-4`}>
        <div className="flex-1" ref={childRef}>
          {children}
        </div>
        <div className="w-64 flex-shrink-0">{renderExtensionFields()}</div>
      </div>
    );
  }

  return (
    <div className={wrapperClass} ref={childRef}>
      {extensionFieldsPosition === "top" && renderExtensionFields()}

      <div className="original-component">{children}</div>

      {extensionFieldsPosition === "bottom" && renderExtensionFields()}
    </div>
  );
}

// Example usage component to demonstrate
function ExampleUsage() {
  // Simulate a user object that might come from an API
  const user = {
    id: 1,
    name: "John Doe",
    email: "john@example.com",
    // These would be added by extensions
    aiScore: 87,
    extensionData: {
      lastModified: new Date().toISOString(),
      source: "extension-proxy",
      generatedBy: "AI Assistant",
    },
    computedRating: "Excellent",
    enhancedProfile: true,
    analysisMetadata: {
      confidence: 0.92,
      processed: true,
    },
  };

  // Original UserCard component (user's existing component)
  const UserCard = ({ user }: { user: any }) => (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold">{user.name}</h3>
      <p className="text-gray-600">{user.email}</p>
      <div className="mt-2 text-sm text-gray-500">ID: {user.id}</div>
    </div>
  );

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <h1 className="text-2xl font-bold mb-8">Extension Wrapper Demo</h1>

      <div className="space-y-8">
        <div>
          <h2 className="text-lg font-semibold mb-4">
            Bottom Position (Default)
          </h2>
          <ExtensionWrapper data={user}>
            <UserCard user={user} />
          </ExtensionWrapper>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-4">Side Position</h2>
          <ExtensionWrapper data={user} extensionFieldsPosition="side">
            <UserCard user={user} />
          </ExtensionWrapper>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-4">Top Position</h2>
          <ExtensionWrapper data={user} extensionFieldsPosition="top">
            <UserCard user={user} />
          </ExtensionWrapper>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-4">
            Extension Fields Hidden
          </h2>
          <ExtensionWrapper data={user} showExtensionFields={false}>
            <UserCard user={user} />
          </ExtensionWrapper>
        </div>
      </div>
    </div>
  );
}
