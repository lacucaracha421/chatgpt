package com.lakomics.mobile;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import java.util.*;

/** Mechanical Android adapter for the separate Somi file; no catalog/library migration. */
final class SomiDatabase implements SomiStore.Db {
    private final SQLiteDatabase db;
    SomiDatabase(Context context){db=context.openOrCreateDatabase("somi.sqlite3",Context.MODE_PRIVATE,null);db.enableWriteAheadLogging();}
    public void exec(String sql,Object... args){db.execSQL(sql,args);}
    public List<Map<String,Object>> query(String sql,Object... args){
        String[] bind=new String[args.length];for(int i=0;i<args.length;i++)bind[i]=args[i]==null?null:args[i].toString();
        List<Map<String,Object>> rows=new ArrayList<>();try(Cursor c=db.rawQuery(sql,bind)){while(c.moveToNext()){Map<String,Object> row=new LinkedHashMap<>();for(int i=0;i<c.getColumnCount();i++)row.put(c.getColumnName(i),c.isNull(i)?null:c.getType(i)==Cursor.FIELD_TYPE_INTEGER?c.getLong(i):c.getString(i));rows.add(row);}}return rows;
    }
    public void transaction(Runnable work){db.beginTransaction();try{work.run();db.setTransactionSuccessful();}finally{db.endTransaction();}}
    void close(){db.close();}
}
