import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  Package, 
  Users, 
  ShoppingCart,
  ArrowUpRight,
  ArrowDownRight,
  Calendar
} from 'lucide-react';
import { motion } from 'motion/react';
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  Legend
} from 'recharts';
import { cn, formatISTDateKeyLabel } from '../lib/utils';
import { useThemeStore } from '../store/useThemeStore';

export const Dashboard = () => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const mode = useThemeStore((state) => state.mode);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getAnalytics()
      .then(setData)
      // Without a catch the failure surfaced only as an unhandled rejection in
      // the console, and the page said "Failed to load analytics." with no
      // indication of why.
      .catch((err: any) => setError(err?.message || 'Could not load analytics.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-center text-gray-400">Loading analytics...</div>;
  if (!data) {
    return (
      <div className="p-8 text-center text-red-400">
        {error || 'Failed to load analytics.'}
      </div>
    );
  }

  // Recharts paints via SVG fill attributes, so these can't be reached by the
  // CSS theme layer. The light ramp starts at a deep indigo that all but
  // disappears on a dark page, so swap in a lifted ramp for dark mode.
  const isDark = mode === 'dark';
  const COLORS = isDark
    ? ['#7c5cf0', '#9b6ef0', '#c07ae8', '#e77fc4', '#f5aede']
    : ['#232d9b', '#5534b7', '#b153d7', '#e164b5', '#f0a4dc'];
  // Grid lines and series strokes are SVG attributes, so the CSS theme layer
  // can't reach them. The light values are a pale lilac grid and a deep indigo
  // line, both of which vanish on a dark card.
  const gridStroke = isDark ? 'rgba(255,255,255,0.10)' : '#e6def8';
  const lineStroke = isDark ? '#9b7cf5' : '#232d9b';
  const barFill = isDark ? '#7c5cf0' : '#5534b7';
  // Straight from the server, which scans the whole items table. Filtering the
  // client-side cache here meant the alert only ever covered the slice of the
  // catalogue that happened to be loaded.
  const lowStockItems: Array<{ id: number; name: string; hsn_code?: string; metric: string; stock_quantity: number }> =
    data.lowStock || [];

  // Every tile below shows a figure that came from the database.
  //
  // Three of these used to carry hardcoded trend badges — "+12.5%", "+8.2%",
  // "-2.4%" — that never changed and were not computed from anything. On a
  // dashboard a shopkeeper uses to decide what to stock, an invented trend is
  // worse than no trend. "Total Orders" was likewise not a count of orders: it
  // tallied how many of the last 30 days had any revenue, so a shop billing
  // three hundred times a day read "30".
  const formatMoney = (value: number) =>
    `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const stats = [
    {
      label: "Today's Revenue",
      value: formatMoney(data.todayRevenue),
      icon: DollarSign,
      color: "from-[#232d9b] to-[#5534b7]",
      iconColor: "text-white",
      note: `${Number(data.todayBillCount || 0).toLocaleString('en-IN')} bills`,
    },
    {
      label: "Monthly Revenue",
      value: formatMoney(data.monthRevenue),
      icon: TrendingUp,
      color: "from-[#5534b7] to-[#b153d7]",
      iconColor: "text-white",
      note: 'This month',
    },
    {
      label: "Top Selling Item",
      value: data.topItems[0]?.name || 'N/A',
      icon: Package,
      color: "from-[#1b1f46] to-[#232d9b]",
      iconColor: "text-white",
      note: data.topItems[0] ? `${Number(data.topItems[0].total_qty).toLocaleString('en-IN')} sold (90d)` : 'No sales yet',
    },
    {
      label: "Bills This Month",
      value: Number(data.monthBillCount || 0).toLocaleString('en-IN'),
      icon: ShoppingCart,
      color: "from-[#b153d7] to-[#e164b5]",
      iconColor: "text-white",
      note: `${Number(data.todayBillCount || 0).toLocaleString('en-IN')} today`,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="relative overflow-hidden rounded-[2rem] border border-white/40 bg-gradient-to-br from-[#232d9b] via-[#5534b7] to-[#e164b5] px-8 py-10 text-white shadow-[0_24px_60px_rgba(35,45,155,0.24)]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.22),transparent_28%),radial-gradient(circle_at_bottom_left,rgba(255,255,255,0.12),transparent_22%)]" />
        <div className="relative flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.35em] text-white/70">Admin Overview</p>
            <h1 className="mt-3 text-4xl font-black tracking-tight">Business Performance Dashboard</h1>
            <p className="mt-3 max-w-2xl text-sm text-white/80">
              Real-time revenue, sales momentum, payment mix, and inventory pressure in one place.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur-sm">
              <p className="text-[11px] uppercase tracking-[0.2em] text-white/65">Revenue Today</p>
              <p className="mt-1 text-xl font-black">{formatMoney(data.todayRevenue)}</p>
            </div>
            <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur-sm">
              <p className="text-[11px] uppercase tracking-[0.2em] text-white/65">Best Seller</p>
              <p className="mt-1 text-xl font-black truncate">{data.topItems[0]?.name || 'N/A'}</p>
            </div>
            <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur-sm col-span-2 sm:col-span-1">
              <p className="text-[11px] uppercase tracking-[0.2em] text-white/65">Low Stock</p>
              <p className="mt-1 text-xl font-black">{lowStockItems.length} items</p>
            </div>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            className="bg-white/90 backdrop-blur-sm p-6 rounded-3xl shadow-[0_18px_40px_rgba(35,45,155,0.08)] border border-white/60 flex flex-col gap-4"
          >
            <div className="flex items-center justify-between">
              <div className={cn("w-12 h-12 rounded-2xl flex items-center justify-center bg-gradient-to-br shadow-lg", stat.color, stat.iconColor)}>
                <stat.icon size={24} />
              </div>
              <div className="text-xs font-bold px-2 py-1 rounded-full bg-purple-100 text-purple-600">
                {stat.note}
              </div>
            </div>
            <div>
              <p className="text-sm font-bold text-gray-400 uppercase tracking-wider">{stat.label}</p>
              <p className="text-2xl font-black text-gray-900 mt-1">{stat.value}</p>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Sales Chart */}
        <div className="lg:col-span-2 bg-white/90 backdrop-blur-sm p-8 rounded-3xl shadow-[0_18px_40px_rgba(35,45,155,0.08)] border border-white/60">
          <div className="flex items-center justify-between mb-8">
            <h3 className="font-bold text-xl">Revenue Overview</h3>
            <div className="flex items-center gap-2 text-sm text-gray-500 bg-gray-50 px-3 py-1.5 rounded-xl border border-gray-100">
              <Calendar size={16} />
              <span>Last 30 Days</span>
            </div>
          </div>
          <div className="h-[350px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.salesByDay}>
                <defs>
                  <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ea580c" stopOpacity={0.1}/>
                    <stop offset="35%" stopColor="#b153d7" stopOpacity={0.18}/>
                    <stop offset="95%" stopColor="#e164b5" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridStroke} />
                <XAxis 
                  dataKey="date" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fill: '#7b74a7', fontSize: 12 }}
                  tickFormatter={(val) => formatISTDateKeyLabel(val)}
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fill: '#7b74a7', fontSize: 12 }}
                  tickFormatter={(val) => `₹${val}`}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#fff', 
                    borderRadius: '16px', 
                    border: '1px solid rgba(85, 52, 183, 0.12)', 
                    boxShadow: '0 18px 40px rgba(35,45,155,0.12)' 
                  }}
                />
                <Area 
                  type="monotone" 
                  dataKey="revenue" 
                  stroke={lineStroke} 
                  strokeWidth={3}
                  fillOpacity={1} 
                  fill="url(#colorRevenue)" 
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Payment Methods */}
        <div className="bg-white/90 backdrop-blur-sm p-8 rounded-3xl shadow-[0_18px_40px_rgba(35,45,155,0.08)] border border-white/60">
          <h3 className="font-bold text-xl mb-8">Payment Methods</h3>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data.paymentMethods}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={8}
                  dataKey="total"
                  nameKey="payment_method"
                >
                  {data.paymentMethods.map((entry: any, index: number) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: '16px', border: '1px solid rgba(85, 52, 183, 0.12)', boxShadow: '0 18px 40px rgba(35,45,155,0.12)' }} />
                <Legend verticalAlign="bottom" height={36} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-6 space-y-3">
            {data.paymentMethods.map((pm: any, i: number) => (
              <div key={pm.payment_method} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                  <span className="capitalize text-gray-500">{pm.payment_method}</span>
                </div>
                <span className="font-bold text-gray-900">₹{pm.total.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Top Items */}
        <div className="bg-white/90 backdrop-blur-sm p-8 rounded-3xl shadow-[0_18px_40px_rgba(35,45,155,0.08)] border border-white/60">
          <h3 className="font-bold text-xl mb-8">Top Selling Items</h3>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.topItems} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={gridStroke} />
                <XAxis type="number" hide />
                <YAxis 
                  dataKey="name" 
                  type="category" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fill: '#4f4a76', fontSize: 12, fontWeight: 600 }}
                  width={100}
                />
                <Tooltip 
                  cursor={{ fill: '#f9fafb' }}
                  contentStyle={{ 
                    backgroundColor: '#fff', 
                    borderRadius: '16px', 
                    border: '1px solid rgba(85, 52, 183, 0.12)', 
                    boxShadow: '0 18px 40px rgba(35,45,155,0.12)' 
                  }}
                />
                <Bar dataKey="total_qty" fill={barFill} radius={[0, 10, 10, 0]} barSize={30} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Low Stock Alert */}
        <div className="bg-white/90 backdrop-blur-sm p-8 rounded-3xl shadow-[0_18px_40px_rgba(35,45,155,0.08)] border border-white/60">
          <div className="flex items-center justify-between mb-8">
            <h3 className="font-bold text-xl">Low Stock Alerts</h3>
            <span className="text-xs font-bold text-purple-600 bg-purple-100 px-2 py-1 rounded-full">
              {lowStockItems.length > 0 ? 'Action Required' : 'Healthy Stock'}
            </span>
          </div>
          <div className="space-y-4">
            {lowStockItems.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-12">All items are in stock</p>
            ) : (
              lowStockItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between rounded-2xl border border-orange-100 bg-gradient-to-r from-[#f5f1ff] to-[#fff1fa] px-4 py-4"
                >
                  <div>
                    <p className="font-semibold text-gray-900">{item.name}</p>
                    <p className="text-sm text-gray-500">HSN: {item.hsn_code || 'Not set'}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-bold uppercase tracking-wider text-purple-600">Stock Left</p>
                    <p className="text-lg font-black text-orange-600">
                      {item.stock_quantity} <span className="text-xs font-medium text-purple-600">{item.metric}</span>
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
