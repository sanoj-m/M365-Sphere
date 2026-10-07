import { useState } from 'react';
import { TreeView } from '@ark-ui/react/tree-view';
import { ChevronRight, FolderClosed, FolderOpen } from 'lucide-react';

// Ported from the Ark UI tree-view pattern to plain JSX + project CSS
// (web-react has no Tailwind/shadcn; styles live in styles.css under .tv-*).
const TreeNode = ({ node, indexPath }) => (
  <TreeView.NodeProvider key={node.id} node={node} indexPath={indexPath}>
    {node.children ? (
      <TreeView.Branch>
        <TreeView.BranchControl className="tv-control">
          <TreeView.BranchIndicator className="tv-indicator">
            <ChevronRight size={14} />
          </TreeView.BranchIndicator>
          <TreeView.BranchText className="tv-text">
            <FolderClosed size={15} className="tv-icon tv-folder-closed" />
            <FolderOpen size={15} className="tv-icon tv-folder-open" />
            <span>{node.name}</span>
          </TreeView.BranchText>
          {node.stats && (
            <span className="tv-stats mono">
              {node.stats.local.toLocaleString()}/{node.stats.graph.toLocaleString()}
            </span>
          )}
          {typeof node.missingTotal === 'number' && node.missingTotal > 0 && (
            <span className="chip bad tv-badge">{node.missingTotal.toLocaleString()} missing</span>
          )}
        </TreeView.BranchControl>
        <TreeView.BranchContent className="tv-branch-content">
          <TreeView.BranchIndentGuide />
          {node.children.map((child, index) => (
            <TreeNode key={child.id} node={child} indexPath={[...indexPath, index]} />
          ))}
        </TreeView.BranchContent>
      </TreeView.Branch>
    ) : (
      <TreeView.Item className="tv-item">
        <TreeView.ItemText className="tv-text">
          <FolderClosed size={14} className="tv-icon tv-leaf-icon" />
          <span className="tv-leaf-name">{node.name}</span>
        </TreeView.ItemText>
        {node.stats && (
          <span className="tv-stats mono">
            {node.stats.local.toLocaleString()}/{node.stats.graph.toLocaleString()}
            {node.stats.missing > 0
              ? <span className="chip bad tv-badge">{node.stats.missing.toLocaleString()} missing</span>
              : <span className="chip ok tv-badge">ok</span>}
          </span>
        )}
      </TreeView.Item>
    )}
  </TreeView.NodeProvider>
);

export default function FolderTreeView({ collection, label, defaultExpandedValue }) {
  // Controlled expansion seeded with every branch so all folders start open;
  // user toggles take over from there.
  const [expanded, setExpanded] = useState(defaultExpandedValue || []);
  return (
    <TreeView.Root
      collection={collection}
      expandedValue={expanded}
      onExpandedChange={e => setExpanded(e.expandedValue)}
      expandOnClick
      className="tv-root"
    >
      {label && <TreeView.Label className="tv-label">{label}</TreeView.Label>}
      <TreeView.Tree className="tv-tree">
        {collection.rootNode.children?.map((node, index) => (
          <TreeNode key={node.id} node={node} indexPath={[index]} />
        ))}
      </TreeView.Tree>
    </TreeView.Root>
  );
}
